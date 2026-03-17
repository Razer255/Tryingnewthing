const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { LiveChat } = require('youtube-chat');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Store per videoId ──
const sessions = {}; // videoId -> { liveChat, messages[], chatters{}, polling }

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

  // Stop existing session if any
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
      const author = chatItem.author?.name || 'Unknown';
      const text   = chatItem.message?.map(m => m.text || '').join('') || '';
      const isPaid = !!chatItem.superchat;
      const amount = chatItem.superchat?.amount || null;

      session.chatters.add(author);
      session.messages.push({ author, text, isPaid, amount, ts: Date.now() });

      // Keep last 300 messages
      if (session.messages.length > 300) session.messages.shift();
    });

    liveChat.on('error', (err) => {
      console.error('[LiveChat error]', err);
    });

    liveChat.on('end', () => {
      console.log(`[LiveChat] Stream ended for ${videoId}`);
      session.connected = false;
    });

    const started = await liveChat.start();
    if (!started) {
      return res.json({ ok: false, error: 'Could not connect. Make sure the stream is currently live and chat is enabled.' });
    }

    session.liveChat  = liveChat;
    session.connected = true;

    console.log(`[connect] Live chat started for ${videoId}`);
    res.json({ ok: true });

  } catch(e) {
    console.error('[connect error]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── Get messages ──
app.get('/api/chat/:videoId', (req, res) => {
  const session = sessions[req.params.videoId];
  if (!session) return res.json({ ok: true, messages: [], total: 0 });

  const since = parseInt(req.query.since) || 0;
  const messages = since > 0
    ? session.messages.filter(m => m.ts > since)
    : session.messages.slice(-60);

  res.json({
    ok: true,
    messages,
    total: session.messages.length,
    chatters: session.chatters.size,
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

app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));