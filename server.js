/* Multi-tenant WhatsApp sender gateway (lean/optimized) */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const BASE_AUTH_DIR = path.resolve(process.env.BASE_AUTH_DIR || './data/auth');
const IDLE_MS = Number(process.env.IDLE_MS || 120000); // 2 minutes

/* ---------------- CORS + frame security (unchanged behavior) ---------------- */

const ALLOWED_ORIGINS = [
  /^https:\/\/.*\.lovable\.app$/,
  'https://lovable.app',
  'https://app.lovable.app',
  'https://whatappi.growthgrid.me',
  'https://coachflow.growthgrid.me',
  'http://localhost:8080',
];

const FRAME_WHITELIST = [
  /\.lovable\.app$/,
  'https://coachflow.growthgrid.me',
  'https://lovable.app',
  'coachflow.growthgrid.me',
  'https://app.lovable.app',
  'http://localhost:8080',
];

function isOriginAllowed(origin) {
  if (!origin) return true; // curl/Postman
  return ALLOWED_ORIGINS.some((entry) =>
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
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  if (/^\/sessions\/[^/]+\/qr(?:$|\/)/.test(req.path)) {
    const allowed = FRAME_WHITELIST
      .map(p => (p instanceof RegExp ? null : (p.startsWith('http') ? p : `https://${p}`)))
      .filter(Boolean)
      .join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${allowed}`);
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
  next();
});

/* ---------------- auth middleware ---------------- */

function requireApiKey(req, res, next) {
  if (!API_TOKEN) return res.status(500).json({ error: 'API token not set' });
  const token = req.get('x-api-key');
  if (token !== API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* ---------------- helpers ---------------- */

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

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

function pruneCaches(authPath) {
  // Nuke heavy Chromium caches but keep auth/session data
  const toDelete = [
    'Default/Cache',
    'Default/Code Cache',
    'Default/Service Worker',
    'Default/GPUCache',
    'Default/Media Cache',
    'GrShaderCache',
    'ShaderCache',
  ];
  for (const rel of toDelete) {
    try { fs.rmSync(path.join(authPath, rel), { recursive: true, force: true }); } catch {}
  }
}

function getAuthPath(trainerId) {
  return path.join(BASE_AUTH_DIR, trainerId);
}

/* ---------------- session manager ---------------- */

const sessions = new Map(); // trainerId -> { client, ready, lastQR, lastError, idleTimer }

/**
 * Chromium hardening / slimming:
 * - disable background/metrics/components/sync/extensions
 * - tiny caches
 * - block images/fonts/media via request interception
 */
const PUP_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-features=Translate,InterestFeed,MediaRouter,OptimizationHints',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--safebrowsing-disable-auto-update',
  '--window-size=800,600',
  '--blink-settings=imagesEnabled=false',           // save bandwidth/paint
  '--disk-cache-size=1',
  '--media-cache-size=1'
];

function setIdleReaper(trainerId) {
  const s = sessions.get(trainerId);
  if (!s) return;
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  if (!IDLE_MS || IDLE_MS < 10000) return; // disabled if too small/zero
  s.idleTimer = setTimeout(async () => {
    try {
      // destroy Chromium to free CPU/RAM; keep auth files
      if (s.client) await s.client.destroy();
    } catch {}
    const authPath = getAuthPath(trainerId);
    pruneCaches(authPath);
    // Mark not ready but keep session container (so status endpoints still work)
    s.ready = false;
    s.lastQR = null;
    s.lastError = 'idle_destroyed';
    s.client = null;
    s.idleTimer = null;
  }, IDLE_MS);
}

function getOrCreateState(trainerId) {
  if (!sessions.has(trainerId)) sessions.set(trainerId, { client: null, ready: false, lastQR: null, lastError: null, idleTimer: null });
  return sessions.get(trainerId);
}

function attachNetworkSlimming(client) {
  // Best-effort: block heavy resources (images, fonts, media, stylesheets, tracking)
  // Not officially documented, but widely used with whatsapp-web.js
  const page = client?.pupPage;
  if (!page || typeof page.setRequestInterception !== 'function') return;

  page.setRequestInterception(true).catch(() => {});
  page.on('request', req => {
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
      return req.abort().catch(() => {});
    }
    const url = req.url();
    if (/google-analytics\.com|gstatic\.com|doubleclick\.net/i.test(url)) {
      return req.abort().catch(() => {});
    }
    return req.continue().catch(() => {});
  });
}

function createClient(trainerId) {
  const authPath = getAuthPath(trainerId);
  ensureDir(authPath);
  cleanChromiumLocks(authPath);

  const state = getOrCreateState(trainerId);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath, clientId: trainerId }),
    qrMaxRetries: 0, // we handle re-init manually
    takeoverOnConflict: true,
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: PUP_FLAGS,
      defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      ignoreHTTPSErrors: true
    }
  });

  client.on('qr', (qr) => { state.lastQR = qr; state.ready = false; state.lastError = null; setIdleReaper(trainerId); });
  client.on('ready', () => {
    state.ready = true; state.lastQR = null; state.lastError = null;
    attachNetworkSlimming(client); // block heavy resources as soon as page is ready
    setIdleReaper(trainerId);
  });
  client.on('authenticated', () => { setIdleReaper(trainerId); });
  client.on('disconnected', (reason) => {
    state.ready = false;
    state.lastError = `disconnected: ${reason}`;
    state.lastQR = null;
    setIdleReaper(trainerId);
    // do not auto-spin forever; re-init happens on demand
  });
  client.on('auth_failure', (msg) => { state.ready = false; state.lastError = `auth_failure: ${msg}`; setIdleReaper(trainerId); });

  state.client = client;
  sessions.set(trainerId, state);
  return state;
}

async function destroySession(trainerId) {
  const s = sessions.get(trainerId);
  if (!s) return;
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  if (s.client) { try { await s.client.destroy(); } catch {} }
  const authPath = getAuthPath(trainerId);
  pruneCaches(authPath);
  sessions.delete(trainerId);
}

async function ensureInitialized(trainerId) {
  const s = getOrCreateState(trainerId);
  if (!s.client) createClient(trainerId);
  cleanChromiumLocks(getAuthPath(trainerId));
  // If Chromium was idle-destroyed, this will relaunch and reuse LocalAuth
  return s.client.initialize().catch((err) => {
    s.ready = false;
    s.lastError = err?.message || String(err);
    throw err;
  });
}

/* ---------------- routes ---------------- */

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
  try {
    await ensureInitialized(trainerId);
  } catch {}
  res.json({ ok: true, trainerId });
});

app.get('/sessions/:id/status', requireApiKey, (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  setIdleReaper(id);
  res.json({ ready: !!s.ready, qrAvailable: !!s.lastQR, lastError: s.lastError });
});

// HEAD support for QR endpoint
app.head('/sessions/:id/qr', (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (s?.lastQR) return res.sendStatus(200);
  return res.sendStatus(404);
});

// QR as JSON (data URL)
app.get('/sessions/:id/qr.json', (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'Session not found. Have you created it?' });
  if (!s.lastQR) return res.status(404).json({ error: 'QR not available yet. Refresh after logs show "qr".' });
  QRCode.toDataURL(s.lastQR)
    .then((dataUrl) => res.json({ qr: dataUrl }))
    .catch(() => res.status(500).json({ error: 'Failed to render QR.' }));
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

  const s = sessions.get(id) || createClient(id);
  try {
    // Lazy-initialize if idle-destroyed
    if (!s.ready) await ensureInitialized(id);
    setIdleReaper(id);

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
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    if (s.client) await s.client.logout();
    await destroySession(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.delete('/sessions/:id', requireApiKey, async (req, res) => {
  const id = req.params.id;
  const purge = String(req.query.purge || 'false') === 'true';
  await destroySession(id);
  if (purge) { try { fs.rmSync(getAuthPath(id), { recursive: true, force: true }); } catch {} }
  res.json({ ok: true, purged: purge });
});

/* ---------------- start ---------------- */
ensureDir(BASE_AUTH_DIR);
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
