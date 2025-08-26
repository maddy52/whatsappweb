const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

let lastQR = null;

// Healthcheck
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Show the QR
app.get('/qr', async (req, res) => {
  if (!lastQR) {
    return res.status(404).send('QR not available yet. Refresh in a few seconds.');
  }
  try {
    const dataUrl = await QRCode.toDataURL(lastQR);
    res.set('Content-Type', 'text/html').send(`
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
        <body style="font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial;">
          <h2>Scan this with WhatsApp on your phone</h2>
          <img src="${dataUrl}" alt="QR" style="max-width:360px;width:100%;height:auto;border:1px solid #ddd;border-radius:12px;padding:8px"/>
          <p>On your phone, open WhatsApp, go to Settings → Linked devices → Link a device.</p>
        </body>
      </html>
    `);
  } catch (e) {
    res.status(500).send('Failed to render QR.');
  }
});

// Simple send endpoint for testing
// Use: /send?to=9715XXXXXXXX&text=Hello
app.get('/send', async (req, res) => {
  try {
    if (!global._wwebClientReady) return res.status(503).json({ ok: false, error: 'Client not ready yet' });
    const to = (req.query.to || '').replace(/\D/g, '');
    const text = req.query.text || '';
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    const chatId = `${to}@c.us`;
    const sent = await global._wwebClient.sendMessage(chatId, text);
    res.json({ ok: true, id: sent.id.id, to: chatId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create a new client with a truly unique Chromium profile dir each boot
function createClient() {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chromiumUserDataDir = `/tmp/chromium-${uniqueSuffix}`;
  try { fs.mkdirSync(chromiumUserDataDir, { recursive: true }); } catch {}

  // Clean common lock files in case Chromium left anything behind
  const possibleLocks = [
    path.join(chromiumUserDataDir, 'SingletonLock'),
    path.join(chromiumUserDataDir, 'SingletonCookie'),
    '/root/.config/chromium/SingletonLock',
    '/root/.config/chromium/SingletonCookie',
    '/home/node/.config/chromium/SingletonLock',
    '/home/node/.config/chromium/SingletonCookie'
  ];
  for (const p of possibleLocks) { try { fs.rmSync(p, { force: true }); } catch {} }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      userDataDir: chromiumUserDataDir, // prefer explicit field over only args
      args: [
        `--user-data-dir=${chromiumUserDataDir}`,
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

  // Logs
  client.on('message', (msg) => console.log('RECV:', msg.from, msg.body));
  client.on('qr', (qr) => { lastQR = qr; console.log('QR received, visit /qr to scan.'); });
  client.on('ready', () => { global._wwebClientReady = true; console.log('WhatsApp client is ready'); });
  client.on('disconnected', (reason) => {
    global._wwebClientReady = false;
    console.log('WhatsApp client disconnected:', reason);
    // try to reinitialize after a short delay
    setTimeout(initClient, 5000);
  });

  return client;
}

function initClient() {
  global._wwebClientReady = false;
  global._wwebClient = createClient();
  // Do not crash the process if Chromium fails to start. Retry instead.
  global._wwebClient.initialize().catch((err) => {
    console.error('Client initialize failed:', err && err.message ? err.message : err);
    setTimeout(initClient, 5000);
  });
}

initClient();

app.listen(PORT, () => {
  console.log(`Server listening on 3000`);
});
