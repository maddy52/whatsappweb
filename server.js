/* Multi-tenant WhatsApp sender gateway */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- allow embedding of QR page from Lovable + your app ----
const FRAME_WHITELIST = [
  /\.lovable\.app$/,                // any *.lovable.app
  'https://coachflow.growthgrid.me',
  'https://lovable.app',
  'coachflow.growthgrid.me',
  'https://app.lovable.app' // your own app host (adjust if needed)
];

function isAllowedFrameOrigin(origin) {
  if (!origin) return true; // let non-browser tools pass
  try {
    const { hostname } = new URL(origin);
    return FRAME_WHITELIST.some(p =>
      p instanceof RegExp ? p.test(hostname) : hostname === p
    );
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  // CORS (what Lovable asked for)
  const origin = req.headers.origin;
  if (isAllowedFrameOrigin(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  // If the requested URL is the QR endpoint, set frame headers
  // so browsers allow <iframe> embedding from Lovable.
  if (/^\/sessions\/[^/]+\/qr(?:$|\/)/.test(req.path)) {
    // Allow frames only from your trusted apps
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://*.lovable.app https://coachflow.growthgrid.me"
    );
    // X-Frame-Options is legacy but some browsers still look at it.
    // ALLOWALL is accepted by Firefox/Chromium to disable the block.
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    // Some browsers also enforce CORP; make it explicit.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  next();
});

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || ''; // set this in Coolify
const BASE_AUTH_DIR = path.resolve(process.env.BASE_AUTH_DIR || './data/auth'); // mount /app/data, uses /app/data/auth/<trainerId>

// ---------- CORS (no external package) ----------
const allowedOrigins = [
  /^https:\/\/.*\.lovable\.app$/,
  'https://lovable.app',
  'https://app.lovable.app',
  'https://whatappi.growthgrid.me',
  'https://coachflow.growthgrid.me'
];

function isOriginAllowed(origin) {
  if (!origin) return true; // curl/postman/no-origin
  return allowedOrigins.some((entry) =>
    entry instanceof RegExp ? entry.test(origin) : entry === origin
  );
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
    // Not using credentials; if you ever do, also set Access-Control-Allow-Credentials: true
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- auth middleware ----------
function requireApiKey(req, res, next) {
  if (!API_TOKEN) return res.status(500).json({ error: 'API token not set' });
  const token = req.get('x-api-key');
  if (token !== API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- helpers ----------
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function cleanChromiumLocks(baseDir) {
  try {
    if (!fs.existsSync(baseDir)) return;
    const stack = [baseDir];
    const targets = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (targets.has(ent.name)) { try { fs.rmSync(p, { force: true }); } catch {} }
      }
    }
  } catch {}
}

function getAuthPath(trainerId) {
  return path.join(BASE_AUTH_DIR, trainerId);
}

// ---------- session manager ----------
const sessions = new Map(); // trainerId -> { client, ready, lastQR, lastError }

function createClient(trainerId) {
  const authPath = getAuthPath(trainerId);
  ensureDir(authPath);
  cleanChromiumLocks(authPath);

  const state = sessions.get(trainerId) || { ready: false, lastQR: null, lastError: null };
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath, clientId: trainerId }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain'
      ]
    }
  });

  client.on('qr', (qr) => { state.lastQR = qr; state.ready = false; state.lastError = null; });
  client.on('ready', () => { state.ready = true; state.lastQR = null; state.lastError = null; });
  client.on('disconnected', (reason) => {
    state.ready = false;
    state.lastError = `disconnected: ${reason}`;
    setTimeout(() => initSession(trainerId), 5000);
  });
  client.on('auth_failure', (msg) => { state.ready = false; state.lastError = `auth_failure: ${msg}`; });

  state.client = client;
  sessions.set(trainerId, state);
  return state;
}

async function destroySession(trainerId) {
  const s = sessions.get(trainerId);
  if (s?.client) { try { await s.client.destroy(); } catch {} }
  sessions.delete(trainerId);
}

function initSession(trainerId) {
  const s = sessions.get(trainerId) || createClient(trainerId);
  s.lastError = null;
  cleanChromiumLocks(getAuthPath(trainerId));
  return s.client.initialize().catch((err) => {
    s.ready = false;
    s.lastError = err?.message || String(err);
    setTimeout(() => {
      cleanChromiumLocks(getAuthPath(trainerId));
      initSession(trainerId);
    }, 5000);
  });
}

// ---------- routes ----------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/', (_req, res) => res.send('WhatsApp sender gateway is up.'));

app.get('/sessions', requireApiKey, (_req, res) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    trainerId: id, ready: !!s.ready, qrAvailable: !!s.lastQR, lastError: s.lastError
  }));
  res.json({ sessions: list });
});

app.post('/sessions', requireApiKey, async (req, res) => {
  const { trainerId } = req.body || {};
  if (!trainerId) return res.status(400).json({ error: 'trainerId is required' });
  if (!sessions.has(trainerId)) createClient(trainerId);
  initSession(trainerId);
  res.json({ ok: true, trainerId });
});

app.get('/sessions/:id/status', requireApiKey, (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({ ready: !!s.ready, qrAvailable: !!s.lastQR, lastError: s.lastError });
});

// HEAD support for QR endpoint
app.head('/sessions/:id/qr', (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (s?.lastQR) return res.sendStatus(200);
  return res.sendStatus(404);
});

// QR page (HTML)
app.get('/sessions/:id/qr', (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).send('Session not found. Have you created it?');
  if (!s.lastQR) return res.status(404).send('QR not available yet. Refresh after logs show "qr".');

  QRCode.toDataURL(s.lastQR)
    .then((dataUrl) => {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.lovable.app");
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.send(`
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head>
        <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
          <h2>Scan this with WhatsApp (${id})</h2>
          <img src="${dataUrl}" alt="QR" style="max-width:360px;width:100%;height:auto;border:1px solid #ddd;border-radius:12px;padding:8px"/>
          <p>WhatsApp → Settings → Linked devices → Link a device.</p>
        </body></html>
      `);
    })
    .catch(() => res.status(500).send('Failed to render QR.'));
});

app.post('/sessions/:id/send', requireApiKey, async (req, res) => {
  const id = req.params.id;
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to and text required' });

  const s = sessions.get(id);
  if (!s || !s.client) return res.status(404).json({ error: 'session not found' });
  if (!s.ready) return res.status(503).json({ error: 'session not ready' });

  try {
    const digits = String(to).replace(/\D/g, '');
    const numberId = await s.client.getNumberId(digits);
    if (!numberId) return res.status(404).json({ error: 'number is not on WhatsApp' });
    const sent = await s.client.sendMessage(numberId._serialized, text);
    res.json({ ok: true, id: sent?.id?.id || null, to: numberId._serialized });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/sessions/:id/logout', requireApiKey, async (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s || !s.client) return res.status(404).json({ error: 'session not found' });
  try { await s.client.logout(); await destroySession(id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});

app.delete('/sessions/:id', requireApiKey, async (req, res) => {
  const id = req.params.id;
  const purge = String(req.query.purge || 'false') === 'true';
  await destroySession(id);
  if (purge) { try { fs.rmSync(getAuthPath(id), { recursive: true, force: true }); } catch {} }
  res.json({ ok: true, purged: purge });
});

// ---------- start ----------
ensureDir(BASE_AUTH_DIR);
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
