const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const chatStore = {};

function getStore(videoId) {
  if (!chatStore[videoId]) {
    chatStore[videoId] = {
      messages: [], continuation: null, apiKey: null,
      clientVersion: null, polling: false, lastPoll: 0, error: null
    };
  }
  return chatStore[videoId];
}

// ── Headers that mimic a real browser ──
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

// ── Step 1: fetch video page and extract continuation + keys ──
async function initChat(videoId) {
  const store = getStore(videoId);
  try {
    const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: HEADERS,
      timeout: 15000,
      maxRedirects: 5,
    });

    const html = res.data;

    // Extract INNERTUBE_API_KEY
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)
                     || html.match(/"innertubeApiKey"\s*:\s*"([^"]+)"/);
    store.apiKey = apiKeyMatch ? apiKeyMatch[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    // Extract client version
    const verMatch = html.match(/"clientVersion"\s*:\s*"([\d.]+)"/)
                  || html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([\d.]+)"/);
    store.clientVersion = verMatch ? verMatch[1] : '2.20240301.01.00';

    // Try multiple patterns to extract ytInitialData
    let initData = null;

    const patterns = [
      /var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s,
      /window\["ytInitialData"\]\s*=\s*(\{.+?\});\s*<\/script>/s,
      /ytInitialData\s*=\s*(\{.+?\});\s*(?:var|const|let|\n)/s,
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        try { initData = JSON.parse(m[1]); break; } catch(e) { continue; }
      }
    }

    // Alternative: extract just the continuation token directly from HTML
    if (!initData) {
      // Try to find continuation token directly in the raw HTML
      const contMatch = html.match(/"continuation"\s*:\s*"([^"]{20,})"/);
      if (contMatch) {
        store.continuation = contMatch[1];
        store.error = null;
        return true;
      }
      throw new Error('Could not parse page data. Stream might not be live.');
    }

    // Walk through ytInitialData to find live chat continuation
    const cont = extractContinuation(initData);
    if (!cont) {
      // Try direct regex on raw HTML as fallback
      const rawCont = html.match(/"reloadContinuationData"\s*:\s*\{"continuation"\s*:\s*"([^"]+)"/);
      if (rawCont) {
        store.continuation = rawCont[1];
        store.error = null;
        return true;
      }
      throw new Error('No live chat found. Make sure the stream is currently live and chat is enabled.');
    }

    store.continuation = cont;
    store.error = null;
    return true;

  } catch(e) {
    store.error = e.message;
    console.error('[initChat]', e.message);
    return false;
  }
}

// ── Recursively search for live chat continuation ──
function extractContinuation(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 15) return null;

  // Direct hit on liveChatRenderer
  if (obj.liveChatRenderer) {
    const lc = obj.liveChatRenderer;
    const conts = lc.continuations;
    if (conts && conts[0]) {
      return conts[0].invalidationContinuationData?.continuation
          || conts[0].timedContinuationData?.continuation
          || conts[0].reloadContinuationData?.continuation
          || null;
    }
  }

  // Check subMenuItems for continuation
  if (Array.isArray(obj.subMenuItems)) {
    for (const item of obj.subMenuItems) {
      const c = item?.continuation?.reloadContinuationData?.continuation;
      if (c) return c;
    }
  }

  // Recurse
  for (const key of Object.keys(obj)) {
    if (key === 'responseContext' || key === 'trackingParams') continue;
    const result = extractContinuation(obj[key], depth + 1);
    if (result) return result;
  }
  return null;
}

// ── Step 2: fetch live chat messages using continuation ──
async function fetchLiveChatMessages(videoId) {
  const store = getStore(videoId);
  if (!store.continuation) return { ok: false, error: 'No continuation token' };

  try {
    const body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: store.clientVersion || '2.20240301.01.00',
          hl: 'en',
          gl: 'US',
        }
      },
      continuation: store.continuation
    };

    const res = await axios.post(
      `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${store.apiKey}&prettyPrint=false`,
      body,
      {
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://www.youtube.com',
          'Referer': `https://www.youtube.com/watch?v=${videoId}`,
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': store.clientVersion || '2.20240301.01.00',
        },
        timeout: 12000,
      }
    );

    const data = res.data;

    // Update continuation for next poll
    const lcc = data?.continuationContents?.liveChatContinuation;
    if (lcc?.continuations?.[0]) {
      const c = lcc.continuations[0];
      const nextCont = c.invalidationContinuationData?.continuation
                    || c.timedContinuationData?.continuation
                    || c.reloadContinuationData?.continuation;
      if (nextCont) store.continuation = nextCont;
    }

    // Parse messages
    const actions = lcc?.actions || [];
    const messages = [];

    for (const action of actions) {
      const item = action?.addChatItemAction?.item;
      if (!item) continue;

      const r = item.liveChatTextMessageRenderer
             || item.liveChatPaidMessageRenderer
             || item.liveChatMembershipItemRenderer;
      if (!r) continue;

      const author = r.authorName?.simpleText || 'Unknown';
      const runs   = r.message?.runs || r.headerSubtext?.runs || [];
      const text   = runs.map(run => run.text || '').join('').trim();
      const isPaid = !!item.liveChatPaidMessageRenderer;
      const isMember = !!item.liveChatMembershipItemRenderer;
      const amount = r.purchaseAmountText?.simpleText || null;

      if (text || isMember) {
        messages.push({
          author,
          text: text || (isMember ? '🎉 Became a member!' : ''),
          isPaid,
          isMember,
          amount,
          ts: Date.now()
        });
      }
    }

    store.messages = [...store.messages, ...messages].slice(-300);
    return { ok: true, count: messages.length };

  } catch(e) {
    console.error('[fetchChat]', e.response?.status, e.message);
    // If 400/403, try re-init
    if (e.response?.status === 400 || e.response?.status === 403) {
      store.continuation = null;
    }
    return { ok: false, error: e.message };
  }
}

// ── Polling loop ──
async function startPolling(videoId) {
  const store = getStore(videoId);
  if (store.polling) return;
  store.polling = true;

  async function loop() {
    if (!store.polling) return;

    // Re-init if continuation lost
    if (!store.continuation) {
      console.log(`[poll] Re-initializing chat for ${videoId}`);
      await initChat(videoId);
    }

    if (store.continuation) {
      await fetchLiveChatMessages(videoId);
    }

    setTimeout(loop, 5000);
  }

  loop();
}

// ══════════════════════════════
//   API ROUTES
// ══════════════════════════════

// Connect to stream
app.post('/api/connect', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ ok: false, error: 'videoId is required' });

  // Reset store
  chatStore[videoId] = null;
  const store = getStore(videoId);

  console.log(`[connect] Initializing video: ${videoId}`);
  const ok = await initChat(videoId);

  if (!ok) {
    return res.json({ ok: false, error: store.error || 'Failed to connect to live chat' });
  }

  // Fetch first batch immediately
  await fetchLiveChatMessages(videoId);
  startPolling(videoId);

  res.json({ ok: true, message: 'Connected successfully' });
});

// Get messages
app.get('/api/chat/:videoId', (req, res) => {
  const { videoId } = req.params;
  const since = parseInt(req.query.since) || 0;
  const store = getStore(videoId);

  const messages = since > 0
    ? store.messages.filter(m => m.ts > since)
    : store.messages.slice(-60);

  res.json({ ok: true, messages, total: store.messages.length });
});

// Disconnect
app.post('/api/disconnect', (req, res) => {
  const { videoId } = req.body;
  if (chatStore[videoId]) chatStore[videoId].polling = false;
  res.json({ ok: true });
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));