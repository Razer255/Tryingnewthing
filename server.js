const express  = require('express');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Dynamically import youtube-chat (ESM package)
let LiveChat;
(async () => {
  const mod = await import('youtube-chat');
  LiveChat = mod.LiveChat;
  console.log('✅ youtube-chat loaded');
})();

// ── Store per videoId ──
const sessions = {};

function getSession(videoId) {
  if (!sessions[videoId]) {
    sessions[videoId] = { liveChat: null, messages: [], chatters: new Set(), connected: false };
  }
  return sessions[videoId];
}

// ── Connect ──
app.post('/api/connect', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ ok: false, error: 'videoId required' });
  if (!LiveChat) return res.json({ ok: false, error: 'Server still loading, try again in a few seconds.' });

  // Stop existing session
  const existing = sessions[videoId];
  if (existing?.liveChat) {
    try { await existing.liveChat.stop(); } catch(e) {}
  }

  // Fresh session
  sessions[videoId] = { liveChat: null, messages: [], chatters: new Set(), connected: false };
  const session = sessions[videoId];

  try {
    const liveChat = new LiveChat({ videoId });

    liveChat.on('chat', (chatItem) => {
      try {
        const author = chatItem.author?.name || 'Unknown';
        const msgArr = chatItem.message || [];
        const text   = Array.isArray(msgArr)
          ? msgArr.map(m => m.text || m.emoji?.shortcuts?.[0] || '').join('')
          : String(msgArr);
        const isPaid = !!chatItem.superchat;
        const amount = chatItem.superchat?.amount || null;

        session.chatters.add(author);
        session.messages.push({ author, text, isPaid, amount, ts: Date.now() });
        if (session.messages.length > 300) session.messages.shift();
      } catch(e) {
        console.error('[chat handler]', e.message);
      }
    });

    liveChat.on('error', (err) => {
      console.error('[LiveChat error]', err?.message || err);
    });

    liveChat.on('end', () => {
      console.log(`[LiveChat] Ended: ${videoId}`);
      session.connected = false;
    });

    const started = await liveChat.start();

    if (!started) {
      return res.json({ ok: false, error: 'Could not connect. Make sure the stream is currently live and chat is enabled.' });
    }

    session.liveChat  = liveChat;
    session.connected = true;
    console.log(`[connect] Started: ${videoId}`);
    res.json({ ok: true });

  } catch(e) {
    console.error('[connect error]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Get messages ──
app.get('/api/chat/:videoId', (req, res) => {
  const session = sessions[req.params.videoId];
  if (!session) return res.json({ ok: true, messages: [], total: 0, chatters: 0, connected: false });

  const since    = parseInt(req.query.since) || 0;
  const messages = since > 0
    ? session.messages.filter(m => m.ts > since)
    : session.messages.slice(-60);

  res.json({
    ok: true,
    messages,
    total:     session.messages.length,
    chatters:  session.chatters.size,
    connected: session.connected
  });
});

// ── Disconnect ──
app.post('/api/disconnect', async (req, res) => {
  const { videoId } = req.body;
  const session = sessions[videoId];
  if (session?.liveChat) {
    try { await session.liveChat.stop(); } catch(e) {}
    session.connected = false;
  }
  res.json({ ok: true });
});

// ── Health ──
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));