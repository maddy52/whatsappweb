/* Multi-tenant WhatsApp sender gateway (on-demand, lean) - media-enabled
   - Adds /sessions/:id/sendMedia to upload and send files (images, audio, video, pdf, doc/docx)
   - Stores media under data/media/<trainerId>/ with retention (default 32 days)
   - Background cleaner removes files older than retentionDays once per day (configurable)
   - Uses multer for robust multipart handling with size limits and MIME/extension validation
   - Keeps existing session/auth behaviour and idle reaper logic
*/

const express = require('express');
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const BASE_AUTH_DIR = path.resolve(process.env.BASE_AUTH_DIR || './data/auth');
const BASE_MEDIA_DIR = path.resolve(process.env.BASE_MEDIA_DIR || './data/media');
// Default to retention in days; can be set via env
const RETENTION_DAYS = Number(process.env.MEDIA_RETENTION_DAYS || 32); // keep 32 days by default
const IDLE_MS = Number(process.env.IDLE_MS || 30000); // 30s

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
  if (!origin) return true; // Allow curl/Postman
  return ALLOWED_ORIGINS.some(o =>
    o instanceof RegExp ? o.test(origin) : origin === o
  );
}

function isValidSessionId(id) {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function getAuthPath(trainerId) {
  const fullPath = path.resolve(BASE_AUTH_DIR, trainerId);
  if (!fullPath.startsWith(BASE_AUTH_DIR)) {
    throw new Error('Invalid session path');
  }
  return fullPath;
}

function getMediaPath(trainerId) {
  const fullPath = path.resolve(BASE_MEDIA_DIR, trainerId);
  if (!fullPath.startsWith(BASE_MEDIA_DIR)) {
    throw new Error('Invalid media path');
  }
  return fullPath;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  if (/^\/sessions\/[^/]+\/qr(?:$|\/)/.test(req.path)) {
    const allowed = FRAME_WHITELIST.join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${allowed}`);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  next();
});

/* ---------------- auth middleware ---------------- */

function requireApiKey(req, res, next) {
  if (!API_TOKEN) return res.status(500).json({ error: 'API token not configured' });

  const token = req.get('x-api-key');
  if (token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  next();
}

/* ---------------- helpers ---------------- */

function ensureDir(p) { try { fssync.mkdirSync(p, { recursive: true }); } catch {} }

function cleanChromiumLocks(baseDir) {
  try {
    if (!fssync.existsSync(baseDir)) return;

    const stack = [baseDir];
    const lockFiles = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);

    while (stack.length) {
      const current = stack.pop();
      const entries = fssync.readdirSync(current, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (lockFiles.has(entry.name)) {
          try { fssync.rmSync(fullPath, { force: true }); } catch {}
        }
      }
    }
  } catch (err) {
    console.error('Failed to clean Chromium locks:', err.message);
  }
}

function pruneCaches(authPath) {
  const toDelete = [
    'Default/Cache',
    'Default/Code Cache',
    'Default/Service Worker',
    'Default/GPUCache',
    'Default/Media Cache',
    'GrShaderCache',
    'ShaderCache',
  ];
  
  for (const relPath of toDelete) {
    try {
      fssync.rmSync(path.join(authPath, relPath), { recursive: true, force: true });
    } catch {}
  }
}

/* ---------------- session manager ---------------- */

const sessions = new Map(); // trainerId -> state

function getOrCreateState(trainerId) {
  if (!sessions.has(trainerId)) {
    sessions.set(trainerId, { 
      client: null, 
      ready: false, 
      lastQR: null, 
      lastError: null, 
      idleTimer: null, 
      initializing: null,
      busy: false
    });
  }
  return sessions.get(trainerId);
}

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
  '--safebrowsing-disable-auto-update',
  '--window-size=800,600',
  '--blink-settings=imagesEnabled=false',
  '--disk-cache-size=1',
  '--media-cache-size=1',
  '--disable-accelerated-2d-canvas'
];

function attachNetworkSlimming(client) {
  try {
    if (!client || !client.pupPage) return;
    const page = client.pupPage;
    if (typeof page.setRequestInterception !== 'function') return;

    page.setRequestInterception(true).catch(() => {});
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();

      if (['image','media','font','stylesheet'].includes(type)) {
        return req.abort().catch(() => {});
      }

      if (/doubleclick|googlesyndication|facebook|metrics/.test(url)) {
        return req.abort().catch(() => {});
      }

      return req.continue().catch(() => {});
    });
  } catch (err) {
    if (process.env.DEBUG) console.warn('attachNetworkSlimming error', err?.message || err);
  }
}

function setIdleReaper(trainerId) {
  const s = sessions.get(trainerId);
  if (!s) return;

  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }

  if (!IDLE_MS || IDLE_MS < 10000) return; // Skip reaping if too low

  if (s.busy || s.initializing) {
    s.idleTimer = setTimeout(() => setIdleReaper(trainerId), 1000);
    return;
  }

  s.idleTimer = setTimeout(async () => {
    if (process.env.DEBUG) console.log(`Session ${trainerId} idle for ${IDLE_MS}ms, destroying client...`);
    
    try {
      if (s.client) await stopClientKeepAuth(trainerId);
    } catch (err) {
      if (process.env.DEBUG) console.warn(`Failed to stop client for ${trainerId}:`, err);
    }

    s.ready = false;
    s.lastQR = null;
    s.lastError = 'idle_destroyed';
    s.client = null;
    s.idleTimer = null;

    if (process.env.DEBUG) console.log(`Session ${trainerId} successfully reaped.`);
  }, IDLE_MS);
}

function createClientInstance(trainerId) {
  const authPath = getAuthPath(trainerId);
  ensureDir(authPath);
  cleanChromiumLocks(authPath);

  const state = getOrCreateState(trainerId);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath, clientId: trainerId }),
    qrMaxRetries: 0,
    takeoverOnConflict: true,
    puppeteer: {
      headless: true,
      executablePath: puppeteer.executablePath() || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: PUP_FLAGS,
      defaultViewport: { width: 800, height: 600 },
      ignoreHTTPSErrors: true
    }
  });

  client.on('qr', (qr) => {
    state.lastQR = qr;
    state.ready = false;
    state.lastError = null;
    console.log(`[${trainerId}] QR RECEIVED`)
    setIdleReaper(trainerId);
  });

  client.on('ready', () => {
    state.ready = true;
    state.lastQR = null;
    state.lastError = null;
    attachNetworkSlimming(client);
    console.log(`[${trainerId}] READY`)
    setIdleReaper(trainerId);
  });

  client.on('authenticated', () => {
    console.log(`[${trainerId}] AUTHENTICATED`);
    setIdleReaper(trainerId)
  });

  client.on('auth_failure', (msg) => {
    state.ready = false;
    state.lastError = `auth_failure: ${msg}`;
    console.log(`[${trainerId}] AUTH FAILURE`, msg)
    setIdleReaper(trainerId);
  });

  client.on('disconnected', (reason) => {
    state.ready = false;
    state.lastError = `disconnected: ${reason}`;
    state.lastQR = null;
    setIdleReaper(trainerId);
  });

  state.client = client;
  state.lastError = null;
  sessions.set(trainerId, state);
  return state;
}

function ensureClientInstance(trainerId) {
  const s = getOrCreateState(trainerId);
  if (!s.client) createClientInstance(trainerId);
  return s;
}

async function stopClientKeepAuth(trainerId) {
  const s = sessions.get(trainerId);
  if (!s) return;

  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  try {
    if (s.client) {
      await s.client.destroy();
    }
  } catch (err) {
    console.warn(`stopClientKeepAuth failed for ${trainerId}:`, err.message);
  }

  s.client = null;
  s.ready = false;
  s.lastQR = null;
  s.lastError = null;
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

  if (s.ready && s.client) {
    setIdleReaper(trainerId);
    return s;
  }

  if (s.initializing) {
    await s.initializing;
    return s.ready ? s : Promise.reject(new Error(s.lastError || 'Initialization failed'));
  }

  ensureClientInstance(trainerId);

  s.initializing = (async () => {
    try {
      if (s.lastError === 'idle_destroyed') s.lastError = null;

      const maxRetries = 3;
      let attempt = 0;
      let lastError;
      while (attempt < maxRetries) {
        try {
          attempt++;
          await s.client.initialize();
          try { attachNetworkSlimming(s.client); } catch {}
          s.lastError = null;
          s.lastQR = s.lastQR || null;
          setIdleReaper(trainerId);
          return;
        } catch (err) {
          lastError = err;
          s.ready = false;
          s.lastError = err?.message || String(err);
          try { await stopClientKeepAuth(trainerId); } catch {}
          if (attempt < maxRetries) {
            await new Promise(res => setTimeout(res, 1000 * attempt));
          }
        }
      }
      throw lastError;
    } finally {
      s.initializing = null;
    }
  })();
  await s.initializing;
  return s;
}

/* ---------------- routes ---------------- */

app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => { res.send('WhatsApp sender gateway is up.'); });

app.get('/sessions', requireApiKey, (_req, res) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    trainerId: id, ready: !!s.ready, qrAvailable: !!s.lastQR, lastError: s.lastError
  }));
  res.json({ sessions: list });
});

app.post('/sessions', requireApiKey, async (req, res) => {
  const { trainerId } = req.body || {};
  if (!trainerId || !isValidSessionId(trainerId)) {
    return res.status(400).json({ error: 'Invalid or missing trainerId' });
  }

  ensureClientInstance(trainerId);

  try {
    await ensureInitialized(trainerId);
  } catch (err) {
    // allow QR fetching even if init failed
  }
  const s = sessions.get(trainerId);
  res.json({ ok: true, trainerId, ready: !!s?.ready, qrAvailable: !!s?.lastQR, lastError: s?.lastError });
});

app.get('/sessions/:id/status', requireApiKey, (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  setIdleReaper(id);
  res.json({ ready: !!s.ready, qrAvailable: !!s.lastQR, lastError: s.lastError });
});

app.head('/sessions/:id/qr', (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (s?.lastQR) return res.sendStatus(200);
  return res.sendStatus(404);
});

app.get('/sessions/:id/qr.json', (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'Session not found. Have you created it?' });
  if (!s.lastQR) return res.status(404).json({ error: 'QR not available yet. Refresh after logs show "qr".' });
  QRCode.toDataURL(s.lastQR)
    .then(qr => res.json({ qr }))
    .catch(() => res.status(500).json({ error: 'Failed to generate QR' }));
});

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

/* ---------------- send text (unchanged) ---------------- */

async function waitForReady(state, timeoutMs = Number(process.env.READY_TIMEOUT_MS || 30000)) {
  if (!state?.client) {
    throw new Error('Client is not initialized');
  }

  if (state.lastQR) {
    throw new Error('Authentication required: scan the QR first');
  }

  if (state.ready) return state.client;

  if (state.initializing) {
    try {
      await state.initializing;
    } catch (e) {}
    if (state.ready) return state.client;
  }

  return new Promise((resolve, reject) => {
    const client = state.client;
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(t);
      client?.off('ready', onReady);
      client?.off('auth_failure', onFail);
      client?.off('disconnected', onFail);
      client?.off('qr', onQR);
    };

    const onReady = () => {
      if (settled) return;
      state.ready = true;
      cleanup();
      resolve(client);
    };

    const onFail = (msg) => {
      if (settled) return;
      cleanup();
      reject(new Error(typeof msg === 'string' ? msg : 'Client failed or disconnected'));
    };

    const onQR = () => {
      if (settled) return;
      cleanup();
      reject(new Error('Authentication required: scan the QR first'));
    };

    client.once('ready', onReady);
    client.once('auth_failure', onFail);
    client.once('disconnected', onFail);
    client.once('qr', onQR);

    const t = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Timeout: Client did not become ready'));
    }, timeoutMs);

    (async () => {
      try {
        const start = Date.now();
        while (!settled && Date.now() - start < timeoutMs) {
          const st = await client.getState().catch(() => undefined);
          if (st === 'CONNECTED') {
            onReady();
            return;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      } catch {} 
    })();
  });
}

async function waitForConnected(client, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await client.getState();
      if (state === 'CONNECTED'){ 
        console.log("wait for connected completed");
        return};
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Timeout waiting for WhatsApp to connect');
}

app.post('/sessions/:id/send', requireApiKey, async (req, res) => {
  const sessionId = req.params.id;
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing "to" or "message"' });
  }

  let state = sessions.get(sessionId);
  if (!state || !state.client || state.destroyed) {
    console.log(`[${sessionId}] Session missing or destroyed, recreating...`);
    if (state) { try { await stopClientKeepAuth(sessionId); } catch {} }
    state = createClientInstance(sessionId);
    sessions.set(sessionId, state);
    await ensureInitialized(sessionId);
  }

  state.busy = true;
  if (state.idleTimer) clearTimeout(state.idleTimer);

  try {
    console.log("waiting for ready");
    const client = await waitForReady(state);
    await waitForConnected(client);

    const phone = String(to).replace(/\D/g, '');
    const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;

    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      return res.status(404).json({ error: 'Recipient is not on WhatsApp' });
    }

    await client.getNumberId(phone);

    console.log("sending to:", chatId);
    const response = await client.sendMessage(chatId, message);

    res.json({ success: true, response });

    if (IDLE_MS === 0) {
      try { await stopClientKeepAuth(sessionId); } catch {}
    }
  } catch (err) {
    console.error('Send failed', err);
    res.status(500).json({ error: err?.message || String(err) });
  } finally {
    state.busy = false;
    try { setIdleReaper(sessionId); } catch {}
  }
});

/* ---------------- send media ---------------- */

// configure multer storage — write to temp location inside media dir then keep
ensureDir(BASE_MEDIA_DIR);

const MAX_FILE_SIZE = Number(process.env.MAX_MEDIA_BYTES || 25 * 1024 * 1024); // default 25MB

// Allowed MIME types + extensions
const ALLOWED_MIMES = new Set([
  'image/jpeg','image/png','image/webp','image/gif','image/heif',
  'video/mp4','video/quicktime','video/webm','audio/mpeg','audio/ogg',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

function fileFilter(req, file, cb) {
  const ok = ALLOWED_MIMES.has(file.mimetype);
  if (!ok) return cb(new Error('Unsupported file type'), false);
  cb(null, true);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const trainerId = req.params.id;
        if (!isValidSessionId(trainerId)) return cb(new Error('Invalid session id'));
        const mediaPath = getMediaPath(trainerId);
        ensureDir(mediaPath);
        cb(null, mediaPath);
      } catch (e) { cb(e); }
    },
    filename: (req, file, cb) => {
      // use timestamp + random for uniqueness
      const ext = path.extname(file.originalname) || '';
      const name = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
      cb(null, name);
    }
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter
});

// helper to validate file extension additionally (defence in depth)
function isAllowedExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  const allowed = ['.jpg','.jpeg','.png','.webp','.gif','.heif','.mp4','.mov','.webm','.mp3','.ogg','.pdf','.doc','.docx'];
  return allowed.includes(ext);
}

app.post('/sessions/:id/sendMedia', requireApiKey, upload.single('file'), async (req, res) => {
  const sessionId = req.params.id;
  const { to, caption } = req.body;

  if (!to) {
    // multer already saved file — ensure we remove it to avoid orphan
    if (req.file) try { await fs.rm(req.file.path); } catch {};
    return res.status(400).json({ error: 'Missing "to" field' });
  }

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // extra extension check
  if (!isAllowedExtension(req.file.originalname)) {
    try { await fs.rm(req.file.path); } catch {}
    return res.status(400).json({ error: 'File extension not allowed' });
  }

  let state = sessions.get(sessionId);
  if (!state || !state.client || state.destroyed) {
    console.log(`[${sessionId}] Session missing or destroyed, recreating...`);
    if (state) { try { await stopClientKeepAuth(sessionId); } catch {} }
    state = createClientInstance(sessionId);
    sessions.set(sessionId, state);
    await ensureInitialized(sessionId);
  }

  state.busy = true;
  if (state.idleTimer) clearTimeout(state.idleTimer);

  try {
    const client = await waitForReady(state);
    await waitForConnected(client);

    const phone = String(to).replace(/\D/g, '');
    const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;

    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      return res.status(404).json({ error: 'Recipient is not on WhatsApp' });
    }

    // Read file and convert to base64 for MessageMedia
    const buffer = await fs.readFile(req.file.path);
    const base64 = buffer.toString('base64');
    const mimetype = req.file.mimetype || 'application/octet-stream';
    const filename = req.file.originalname;

    const media = new MessageMedia(mimetype, base64, filename);

    // send
    const sendResult = await client.sendMessage(chatId, media, { caption: caption || undefined });

    res.json({ success: true, file: path.basename(req.file.path), sendResult });

    if (IDLE_MS === 0) {
      try { await stopClientKeepAuth(sessionId); } catch {}
    }
  } catch (err) {
    console.error('Send media failed', err);
    // do not delete file on failure — we keep media retained for retries/inspection
    res.status(500).json({ error: err?.message || String(err) });
  } finally {
    state.busy = false;
    try { setIdleReaper(sessionId); } catch {}
  }
});

/* ---------------- media retention cleaner ---------------- */

// Run a daily sweep to remove files older than RETENTION_DAYS. Also run at startup.
async function sweepMediaDir() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (!fssync.existsSync(BASE_MEDIA_DIR)) return;

    const trainers = await fs.readdir(BASE_MEDIA_DIR, { withFileTypes: true });
    for (const t of trainers) {
      if (!t.isDirectory()) continue;
      const trainerId = t.name;
      if (!isValidSessionId(trainerId)) continue;
      const dir = getMediaPath(trainerId);
      const files = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const f of files) {
        if (!f.isFile()) continue;
        const full = path.join(dir, f.name);
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoff) {
            await fs.rm(full, { force: true });
            if (process.env.DEBUG) console.log('Removed old media', full);
          }
        } catch (e) {
          // ignore single-file errors
        }
      }
      // optional: remove empty trainer dir
      try {
        const remaining = await fs.readdir(dir);
        if (remaining.length === 0) await fs.rmdir(dir).catch(() => {});
      } catch {}
    }
  } catch (e) { console.error('Media sweep failed', e); }
}

// schedule daily (once per 24h) and run at startup
sweepMediaDir().catch(() => {});
setInterval(() => { sweepMediaDir().catch(() => {}); }, 24 * 60 * 60 * 1000);

/* ---------------- logout / delete ---------------- */

app.post('/sessions/:id/logout', requireApiKey, async (req, res) => {
  const id = req.params.id;

  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  const s = sessions.get(id);
  if (!s) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    if (s.client?.logout) {
      await s.client.logout();
    }
    await destroySession(id);
    res.json({ ok: true });
  } catch (err) {
    console.error(`Logout error for ${id}:`, err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.delete('/sessions/:id', requireApiKey, async (req, res) => {
  const id = req.params.id;
  const purge = true;

  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  try {
    await destroySession(id);

    if (purge) {
      try {
        const authPath = getAuthPath(id);
        await fs.rm(authPath, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to purge auth data for session ${id}:`, err);
      }
      // also purge media for this trainer
      try {
        const mediaPath = getMediaPath(id);
        await fs.rm(mediaPath, { recursive: true, force: true });
      } catch (err) {}
    }

    res.json({ ok: true, purged: purge });
  } catch (e) {
    console.error(`Failed to delete session ${id}:`, e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ---------------- start ---------------- */
ensureDir(BASE_AUTH_DIR);
ensureDir(BASE_MEDIA_DIR);
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
