const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory chat store per videoId ──
const chatStore = {}; // videoId -> { messages: [], continuations: {}, polling: false }

function getStore(videoId) {
  if (!chatStore[videoId]) {
    chatStore[videoId] = { messages: [], continuation: null, polling: false, lastPoll: 0 };
  }
  return chatStore[videoId];
}

// ── Scrape YouTube live chat (no API key) ──
async function scrapeLiveChat(videoId) {
  const store = getStore(videoId);
  try {
    // Step 1: fetch video page to get continuation token
    if (!store.continuation) {
      const pageRes = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 10000
      });

      const html = pageRes.data;

      // Extract ytInitialData
      const match = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s)
                 || html.match(/ytInitialData\s*=\s*(\{.+?\});/s);
      if (!match) throw new Error('Could not find ytInitialData');

      let initData;
      try { initData = JSON.parse(match[1]); } catch(e) { throw new Error('Failed to parse ytInitialData'); }

      // Walk JSON to find liveChatRenderer continuation
      const cont = findContinuation(initData);
      if (!cont) throw new Error('No live chat found — stream may not be live');
      store.continuation = cont;

      // Also extract API key and client version
      const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      const versionMatch = html.match(/"clientVersion"\s*:\s*"([^"]+)"/);
      store.apiKey        = apiKeyMatch  ? apiKeyMatch[1]  : 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
      store.clientVersion = versionMatch ? versionMatch[1] : '2.20240101.00.00';
    }

    // Step 2: fetch live chat messages using continuation
    const chatRes = await axios.post(
      `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${store.apiKey}`,
      {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: store.clientVersion,
          }
        },
        continuation: store.continuation
      },
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 10000
      }
    );

    const data = chatRes.data;

    // Extract next continuation
    const nextCont = findNextContinuation(data);
    if (nextCont) store.continuation = nextCont;

    // Extract messages
    const actions = data?.continuationContents?.liveChatContinuation?.actions || [];
    const newMessages = [];

    actions.forEach(action => {
      const item = action?.addChatItemAction?.item;
      if (!item) return;

      const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
      if (!renderer) return;

      const author  = renderer.authorName?.simpleText || 'Unknown';
      const msgRuns = renderer.message?.runs || [];
      const text    = msgRuns.map(r => r.text || '').join('');
      const color   = renderer.authorNameTextColor
        ? '#' + (renderer.authorNameTextColor >>> 0).toString(16).slice(2)
        : null;
      const isPaid  = !!item.liveChatPaidMessageRenderer;
      const amount  = renderer.purchaseAmountText?.simpleText || null;

      if (text) {
        newMessages.push({ author, text, color, isPaid, amount, ts: Date.now() });
      }
    });

    // Keep last 200 messages
    store.messages = [...store.messages, ...newMessages].slice(-200);
    return { ok: true, newCount: newMessages.length };

  } catch(e) {
    console.error('Scrape error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Helper: find initial continuation token ──
function findContinuation(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return null;
  if (obj.liveChatRenderer) {
    const conts = obj.liveChatRenderer?.header?.liveChatHeaderRenderer?.viewSelector
      ?.sortFilterSubMenuRenderer?.subMenuItems;
    if (conts) {
      for (const item of conts) {
        const cont = item?.continuation?.reloadContinuationData?.continuation;
        if (cont) return cont;
      }
    }
    const cont2 = obj.liveChatRenderer?.continuations?.[0]?.invalidationContinuationData?.continuation
               || obj.liveChatRenderer?.continuations?.[0]?.timedContinuationData?.continuation
               || obj.liveChatRenderer?.continuations?.[0]?.reloadContinuationData?.continuation;
    if (cont2) return cont2;
  }
  for (const key of Object.keys(obj)) {
    const result = findContinuation(obj[key], depth + 1);
    if (result) return result;
  }
  return null;
}

// ── Helper: find next continuation token ──
function findNextContinuation(data) {
  const conts = data?.continuationContents?.liveChatContinuation?.continuations;
  if (!conts || !conts[0]) return null;
  return conts[0]?.invalidationContinuationData?.continuation
      || conts[0]?.timedContinuationData?.continuation
      || conts[0]?.reloadContinuationData?.continuation
      || null;
}

// ── Start polling for a video ──
async function startPolling(videoId) {
  const store = getStore(videoId);
  if (store.polling) return;
  store.polling = true;

  async function poll() {
    if (!store.polling) return;
    await scrapeLiveChat(videoId);
    store.lastPoll = Date.now();
    setTimeout(poll, 4000); // poll every 4 seconds
  }
  poll();
}

// ── API Routes ──

// Start/connect to a stream
app.post('/api/connect', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.json({ ok: false, error: 'videoId required' });

  const store = getStore(videoId);
  store.continuation = null; // reset so we re-fetch from page

  const result = await scrapeLiveChat(videoId);
  if (!result.ok) return res.json({ ok: false, error: result.error });

  startPolling(videoId);
  res.json({ ok: true, message: 'Connected and polling' });
});

// Get latest messages (frontend polls this)
app.get('/api/chat/:videoId', (req, res) => {
  const { videoId } = req.params;
  const since       = parseInt(req.query.since) || 0;
  const store       = getStore(videoId);
  if (!store) return res.json({ ok: true, messages: [] });

  const messages = since > 0
    ? store.messages.filter(m => m.ts > since)
    : store.messages.slice(-50);

  res.json({ ok: true, messages, total: store.messages.length });
});

// Stop polling
app.post('/api/disconnect', (req, res) => {
  const { videoId } = req.body;
  if (chatStore[videoId]) chatStore[videoId].polling = false;
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
