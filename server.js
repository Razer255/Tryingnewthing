const express = require('express');
const cors    = require('cors');
const path    = require('path');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

function getSession(videoId) {
  if (!sessions[videoId]) {
    sessions[videoId] = {
      messages: [], chatters: new Set(),
      continuation: null, apiKey: null, clientVersion: null,
      connected: false, polling: false, retries: 0
    };
  }
  return sessions[videoId];
}

// ── Rotate user agents to avoid blocks ──
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

// ── Fetch YouTube page and extract keys ──
async function initSession(videoId) {
  const session = getSession(videoId);
  try {
    const ua  = randomUA();
    const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': ua,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
      timeout: 20000,
      maxRedirects: 5,
    });

    const html = res.data;

    // ── Extract API key ──
    const apiKeyPatterns = [
      /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/,
      /"innertubeApiKey"\s*:\s*"([^"]+)"/,
      /['"]INNERTUBE_API_KEY['"]\s*:\s*['"]([^'"]+)['"]/,
    ];
    for (const p of apiKeyPatterns) {
      const m = html.match(p);
      if (m) { session.apiKey = m[1]; break; }
    }
    if (!session.apiKey) session.apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    // ── Extract client version ──
    const verPatterns = [
      /"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/,
      /"clientVersion"\s*:\s*"([\d.]+)"/,
    ];
    for (const p of verPatterns) {
      const m = html.match(p);
      if (m && m[1].includes('.')) { session.clientVersion = m[1]; break; }
    }
    if (!session.clientVersion) session.clientVersion = '2.20240301.01.00';

    // ── Extract continuation token ──
    // Try multiple patterns
    const contPatterns = [
      /"invalidationContinuationData"\s*:\s*\{"continuation"\s*:\s*"([^"]{20,})"/,
      /"timedContinuationData"\s*:\s*\{"timeout[^}]*"continuation"\s*:\s*"([^"]{20,})"/,
      /"reloadContinuationData"\s*:\s*\{"continuation"\s*:\s*"([^"]{20,})"/,
      /liveChatRenderer[^}]{0,500}"continuation"\s*:\s*"([^"]{20,})"/s,
    ];

    for (const p of contPatterns) {
      const m = html.match(p);
      if (m) { session.continuation = m[1]; break; }
    }

    // Fallback: parse ytInitialData JSON
    if (!session.continuation) {
      const jsonPatterns = [
        /ytInitialData\s*=\s*(\{.+?);\s*(?:window\[|var |<\/script>)/s,
        /window\["ytInitialData"\]\s*=\s*(\{.+?);\s*<\/script>/s,
      ];

      for (const p of jsonPatterns) {
        const m = html.match(p);
        if (!m) continue;
        try {
          const data = JSON.parse(m[1]);
          const cont = deepFind(data, 'continuation', 15);
          if (cont && typeof cont === 'string' && cont.length > 20) {
            session.continuation = cont;
            break;
          }
        } catch(e) { continue; }
      }
    }

    if (!session.continuation) {
      throw new Error('Stream not found or not currently live. Make sure the stream is live and chat is enabled.');
    }

    session.ua = ua;
    console.log(`[init] OK videoId=${videoId} apiKey=${session.apiKey.slice(0,10)}... cont=${session.continuation.slice(0,20)}...`);
    return true;

  } catch(e) {
    console.error('[initSession]', e.message);
    session.error = e.message;
    return false;
  }
}

// ── Deep find a key in nested object ──
function deepFind(obj, key, maxDepth, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > maxDepth) return null;
  if (key in obj) {
    const val = obj[key];
    // Look for continuation strings specifically
    if (key === 'continuation' && typeof val === 'string' && val.length > 20) return val;
    if (key === 'continuation' && typeof val === 'object') {
      const inner = val.reloadContinuationData?.continuation
                 || val.invalidationContinuationData?.continuation
                 || val.timedContinuationData?.continuation;
      if (inner) return inner;
    }
  }
  for (const k of Object.keys(obj)) {
    if (['responseContext', 'trackingParams', 'clickTrackingParams'].includes(k)) continue;
    const result = deepFind(obj[k], key, maxDepth, depth + 1);
    if (result) return result;
  }
  return null;
}

// ── Fetch chat messages ──
async function fetchMessages(videoId) {
  const session = getSession(videoId);
  if (!session.continuation) return false;

  try {
    const res = await axios.post(
      `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false`,
      {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: session.clientVersion,
            hl: 'en',
            gl: 'US',
            visitorData: '',
            userAgent: session.ua,
          }
        },
        continuation: session.continuation
      },
      {
        headers: {
          'User-Agent': session.ua,
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://www.youtube.com',
          'Referer': `https://www.youtube.com/watch?v=${videoId}`,
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': session.clientVersion,
          'X-Goog-Visitor-Id': '',
        },
        timeout: 15000,
      }
    );

    const lcc = res.data?.continuationContents?.liveChatContinuation;
    if (!lcc) {
      console.warn('[fetchMessages] No liveChatContinuation in response');
      return false;
    }

    // Update continuation
    const conts = lcc.continuations?.[0];
    if (conts) {
      const next = conts.invalidationContinuationData?.continuation
                || conts.timedContinuationData?.continuation
                || conts.reloadContinuationData?.continuation;
      if (next) session.continuation = next;
    }

    // Parse actions
    const actions = lcc.actions || [];
    let added = 0;
    for (const action of actions) {
      const item = action?.addChatItemAction?.item;
      if (!item) continue;

      const r = item.liveChatTextMessageRenderer
             || item.liveChatPaidMessageRenderer
             || item.liveChatMembershipItemRenderer;
      if (!r) continue;

      const author = r.authorName?.simpleText || 'Unknown';
      const runs   = r.message?.runs || r.headerSubtext?.runs || [];
      const text   = runs.map(run => run.text || run.emoji?.shortcuts?.[0] || '').join('').trim();
      const isPaid = !!item.liveChatPaidMessageRenderer;
      const amount = r.purchaseAmountText?.simpleText || null;

      if (text || isPaid) {
        session.chatters.add(author);
        session.messages.push({ author, text, isPaid, amount, ts: Date.now() });
        added++;
      }
    }

    if (session.messages.length > 300) {
      session.messages = session.messages.slice(-300);
    }

    session.retries = 0;
    return true;

  } catch(e) {
    console.error('[fetchMessages]', e.response?.status, e.message);

    // On 400/403 try re-init
    if (e.response?.status === 400 || e.response?.status === 403 || e.response?.status === 429) {
      session.retries++;
      if (session.retries <= 3) {
        console.log(`[fetchMessages] Re-initializing (attempt ${session.retries})...`);
        session.continuation = null;
        await initSession(videoId);
      }
    }
    return false;
  }
}

// ── Poll loop ──
async function startPolling(videoId) {
  const session = getSession(videoId);
  if (session.polling) return;
  session.polling = true;

  async function loop() {
    if (!sessions[videoId]?.polling) return;
    if (!session.continuation) {
      await initSession(videoId);
    }
    await fetchMessages(videoId);
    setTimeout(loop, 5000);
  }
  loop();
}

// ══════════════════════════
//   ROUTES
// ══════════════════════════

app.post('/api/connect', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ ok: false, error: 'videoId required' });

  // Reset
  if (sessions[videoId]) sessions[videoId].polling = false;
  sessions[videoId] = null;

  const ok = await initSession(videoId);
  if (!ok) {
    const session = getSession(videoId);
    return res.json({ ok: false, error: session.error || 'Failed to connect' });
  }

  const session = getSession(videoId);
  session.connected = true;

  // Fetch first batch
  await fetchMessages(videoId);
  startPolling(videoId);

  res.json({ ok: true });
});

app.get('/api/chat/:videoId', (req, res) => {
  const session = sessions[req.params.videoId];
  if (!session) return res.json({ ok: true, messages: [], total: 0, chatters: 0, connected: false });

  const since    = parseInt(req.query.since) || 0;
  const messages = since > 0
    ? session.messages.filter(m => m.ts > since)
    : session.messages.slice(-60);

  res.json({
    ok: true, messages,
    total:     session.messages.length,
    chatters:  session.chatters.size,
    connected: session.connected
  });
});

app.post('/api/disconnect', async (req, res) => {
  const { videoId } = req.body;
  if (sessions[videoId]) sessions[videoId].polling = false;
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
