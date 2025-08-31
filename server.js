/* Multi-tenant WhatsApp sender gateway (on-demand, lean) */
const express = require('express');
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '1mb' }));


const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const BASE_AUTH_DIR = path.resolve(process.env.BASE_AUTH_DIR || './data/auth');
// Default to very short idle time to free resources quickly. Set via env if needed.
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

//moiz refractored
function isValidSessionId(id) {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

//moiz refractored
function getAuthPath(trainerId) {
  const fullPath = path.resolve(BASE_AUTH_DIR, trainerId);
  if (!fullPath.startsWith(BASE_AUTH_DIR)) {
    throw new Error('Invalid session path');
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
  
  for (const relPath of toDelete) {
    try {
      fssync.rmSync(path.join(authPath, relPath), { recursive: true, force: true });
    } catch {}
  }
}

/* ---------------- session manager ---------------- */

/**
 * session state:
 * {
 *   client, ready, lastQR, lastError, idleTimer, initializing (Promise|null)
 * }
 */
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
      busy: false // NEW: prevents idle reaper during active operations
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
  '--disable-accelerated-2d-canvas',
  '--headless=new' // modern headless mode
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
    // swallow — network slimming is best-effort
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

    // If busy, defer scheduling until not busy
  if (s.busy) {
    // schedule a short retry to check later (best-effort)
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


/**
 * Create the client instance and attach only minimal event handlers.
 * Does not call initialize() here — that's done explicitly in ensureInitialized.
 */
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
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: PUP_FLAGS,
      defaultViewport: { width: 800, height: 600 },
      ignoreHTTPSErrors: true
    }
  });

  // Minimal event handlers only
  client.on('qr', (qr) => {
    state.lastQR = qr;
    state.ready = false;
    state.lastError = null;
    setIdleReaper(trainerId);
  });

  client.on('ready', () => {
    state.ready = true;
    state.lastQR = null;
    state.lastError = null;
    // slim the network to reduce CPU/memory while client is alive
    attachNetworkSlimming(client);
    setIdleReaper(trainerId);
  });

  client.on('authenticated', () => setIdleReaper(trainerId));

  client.on('auth_failure', (msg) => {
    state.ready = false;
    state.lastError = `auth_failure: ${msg}`;
    setIdleReaper(trainerId);
  });

  client.on('disconnected', (reason) => {
    state.ready = false;
    state.lastError = `disconnected: ${reason}`;
    state.lastQR = null;
    setIdleReaper(trainerId);
    // we intentionally do NOT auto re-init here; initialize on demand
  });

  // Keep a ref but do not mark ready until initialize resolves
  state.client = client;
  // state.lastError = null;
  sessions.set(trainerId, state);
  return state;
}

/**
 * Ensure client is created (but not necessarily initialized).
 */
function ensureClientInstance(trainerId) {
  const s = getOrCreateState(trainerId);
  if (!s.client) createClientInstance(trainerId);
  return s;
}

/**
 * Stop/destroy the active client but KEEP the auth files so user won't need QR next time.
 */
async function stopClientKeepAuth(trainerId) {
  const s = sessions.get(trainerId);
  if (!s) return;

  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  try {
    if (s.client) {
      await s.client.destroy(); // Kills Chromium process
    }
  } catch (err) {
    console.warn(`stopClientKeepAuth failed for ${trainerId}:`, err.message);
  }

  s.client = null;
  s.ready = false;
  s.lastQR = null;
  s.lastError = null;
}

/**
 * Fully destroy session and auth dir
 */
async function destroySession(trainerId) {
  const s = sessions.get(trainerId);
  if (!s) return;
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  if (s.client) { try { await s.client.destroy(); } catch {} }
  const authPath = getAuthPath(trainerId);
  pruneCaches(authPath);
  sessions.delete(trainerId);
}

/**
 * Core: initialize (start Chromium & whatsapp-web.js).
 * This is serialized per-trainer via s.initializing Promise to avoid duplicate launches.
 * Returns the state (with initialized client).
 */

async function ensureInitialized(trainerId) {
  const s = getOrCreateState(trainerId);

  // If already ready, touch idle timer and return
  if (s.ready && s.client) {
    setIdleReaper(trainerId);
    return s;
  }

  // If initialization is already running, wait for it
  if (s.initializing) {
    await s.initializing;
    return s.ready ? s : Promise.reject(new Error(s.lastError || 'Initialization failed'));
  }

  // Create instance if missing
  ensureClientInstance(trainerId);

  // Create a new initializing promise
  s.initializing = (async () => {
    const maxRetries = 3;
    let attempt = 0;
    let lastError;

    while (attempt < maxRetries) {
      try {
        attempt++;
        // initialize will spawn Chromium (heavy step)
        await s.client.initialize();
        try { attachNetworkSlimming(s.client); } catch {}
        s.lastError = null;
        s.lastQR = s.lastQR || null;
        // s.ready will be flipped by client 'ready' event
        setIdleReaper(trainerId);
        return; // success → exit retry loop
      } catch (err) {
        lastError = err;
        s.ready = false;
        s.lastError = err?.message || String(err);
        // kill half-initialized client to avoid zombie
        try { await stopClientKeepAuth(trainerId); } catch {}

        if (attempt < maxRetries) {
          // small delay before retry (exponential backoff optional)
          await new Promise(res => setTimeout(res, 1000 * attempt));
        }
      }
    }

    // if all retries failed
    throw lastError;
  })();

  await s.initializing;
  return s;
}

/* ---------------- routes ---------------- */

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/', (_req, res) => {
  res.send('WhatsApp sender gateway is up.');
});

app.get('/sessions', requireApiKey, (_req, res) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    trainerId: id, ready: !!s.ready, qrAvailable: !!s.lastQR, lastError: s.lastError
  }));
  res.json({ sessions: list });
});

/**
 * Create a session record and initialize to produce QR (on-demand)
 * This endpoint will spin Chromium so user can scan QR.
 */
app.post('/sessions', requireApiKey, async (req, res) => {
  const { trainerId } = req.body || {};
  if (!trainerId || !isValidSessionId(trainerId)) {
    return res.status(400).json({ error: 'Invalid or missing trainerId' });
  }

  ensureClientInstance(trainerId);

  try {
    // initialize only to show QR / authenticate. If already authenticated, will return quickly.
    await ensureInitialized(trainerId);
  } catch (err) {
    // If initialization failed but we have a lastQR, let the client fetch it.
    // Return progress anyway (we keep state so QR route can check).
  }
  const s = sessions.get(trainerId);
  res.json({ ok: true, trainerId, ready: !!s?.ready, qrAvailable: !!s?.lastQR, lastError: s?.lastError });
});

/**
 * Get session status
 */
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
    .then(qr => res.json({ qr }))
    .catch(() => res.status(500).json({ error: 'Failed to generate QR' }));
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

/**
 * Send text message (on-demand)
 * Behavior: initialize client if necessary, send, then IMMEDIATELY destroy Chromium (keeping auth).
 * This minimizes CPU and RAM usage between sends.
 */

async function waitForReady(state, timeoutMs = Number(process.env.READY_TIMEOUT_MS || 30000)) {
  if (!state?.client) {
    throw new Error('Client is not initialized');
  }

  // If a QR is already present, we know we’re not authenticated yet.
  if (state.lastQR) {
    throw new Error('Authentication required: scan the QR first');
  }

  if (state.ready) return state.client;

  // If a global initialization is in progress for this state, wait for it first
  if (state.initializing) {
    try {
      await state.initializing;
    } catch (e) {
      // initialization failed — propagate later via normal event listeners/timeouts
    }
    if (state.ready) return state.client;
  }

  // Race: ready/auth_failure/disconnected/timeout, and also poll getState()
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

    // Attach listeners BEFORE kicking initialize
    client.once('ready', onReady);
    client.once('auth_failure', onFail);
    client.once('disconnected', onFail);
    client.once('qr', onQR);

    // Timeout
    const t = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Timeout: Client did not become ready'));
    }, timeoutMs);

    // Also poll getState() to fast-path if already connected but 'ready' not yet emitted
    (async () => {
      try {
        // 6 quick probes within timeout
        const start = Date.now();
        while (!settled && Date.now() - start < timeoutMs) {
          const st = await client.getState().catch(() => undefined);
          if (st === 'CONNECTED') {
            onReady();
            return;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      } catch {} // ignore, rely on main events/timeout
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
    } catch (e) {
      // client not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Timeout waiting for WhatsApp to connect');
}

async function waitForWapiInjection(client, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await client.pupPage.evaluate(() => {
        return typeof window.Store !== 'undefined' &&
               typeof window.Store.Chat !== 'undefined';
      });
      if (ok){
        console.log("wait for W api injection completed");
        return;
      }
    } catch (e) {
      // ignore until ready
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Timeout: WhatsApp API not injected');
}


app.post('/sessions/:id/send', requireApiKey, async (req, res) => {
  const sessionId = req.params.id;
  console.log(req.body);
  let { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing "to" or "message"' });
  }

  // Ensure valid state exists
  let state = sessions.get(sessionId);
  if (!state || !state.client || state.destroyed) {
  console.log(`[${sessionId}] Session missing or destroyed, recreating...`);

  if (state) {
        try {
          await stopClientKeepAuth(sessionId);
        } catch (err) {
          console.warn(`[${sessionId}] stopClientKeepAuth failed:`, err.message);
        }
      }
    
    state = createClientInstance(sessionId);
    sessions.set(sessionId, state);
    state.client.initialize();
  }

  // Prevent idle reaper from killing this session mid-send
  state.busy = true;
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }

  try {
      // Wait until ready (will rely on events/polling)
    console.log("waiting for ready");
    const client = await waitForReady(state);
    await waitForConnected(client);  // <--- make sure WhatsApp injected fully
    await waitForWapiInjection(client);   // <--- NEW strict check
    
    const phone = String(to).replace(/\D/g, '');
    const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    const chat = await client.getChatById(chatId);
    console.log(chat, "chat arrived");
    const response = await client.sendMessage(chatId, message);

    res.json({ success: true, response });

    // If the admin wants immediate tear-down between sends (legacy behavior),
    // prefer a graceful stop that keeps auth files.
    if (IDLE_MS === 0) {
      try {
        await stopClientKeepAuth(sessionId); // safer than client.destroy()
      } catch (e) {
        if (process.env.DEBUG) console.warn('stopClientKeepAuth after send failed', e?.message || e);
      }
    }
  } catch (err) {
    console.error('Send failed', err);
    res.status(500).json({ error: err?.message || String(err) });
  } finally {
    // allow idle reaper again (will schedule next reap)
    state.busy = false;
    try { setIdleReaper(sessionId); } catch {}
  }
});



/**
 * Logout: destroys client and wipes auth dir (unless you want to keep auth)
 */

//moiz refractored
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

//moiz refractored
app.delete('/sessions/:id', requireApiKey, async (req, res) => {
  const id = req.params.id;
  const purge =  true;

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
    }

    res.json({ ok: true, purged: purge });
  } catch (e) {
    console.error(`Failed to delete session ${id}:`, e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ---------------- start ---------------- */
ensureDir(BASE_AUTH_DIR);
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
