const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Store the latest QR so you can view it in the browser
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

// Make a unique Chromium profile dir per container to avoid profile lock on rolling updates
const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const chromiumUserDataDir = `/tmp/chromium-${uniqueSuffix}`;
try { fs.mkdirSync(chromiumUserDataDir, { recursive: true }); } catch {}

// Clean common Chromium lock files if they exist
const possibleLocks = [
  path.join(chromiumUserDataDir, 'SingletonLock'),
  path.join(chromiumUserDataDir, 'SingletonCookie'),
  '/root/.config/chromium/SingletonLock',
  '/root/.config/chromium/SingletonCookie',
  '/home/node/.config/chromium/SingletonLock',
  '/home/node/.config/chromium/SingletonCookie'
];
for (const p of possibleLocks) {
  try { fs.rmSync(p, { force: true }); } catch {}
}

// Create and initialise the WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
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
      `--user-data-dir=${chromiumUserDataDir}`,
      '--profile-directory=Default'
    ]
  }
});

// Log incoming messages to runtime logs
client.on('message', (msg) => {
  console.log('RECV:', msg.from, msg.body);
});

// Quick test endpoint to send a message
// Use: /send?to=9715XXXXXXXX&text=Hello
app.get('/send', async (req, res) => {
  try {
    const to = (req.query.to || '').replace(/\D/g, '');
    const text = req.query.text || '';
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });

    const chatId = `${to}@c.us`; // full international number without +
    const sent = await client.sendMessage(chatId, text);
    res.json({ ok: true, id: sent.id.id, to: chatId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

client.on('qr', (qr) => {
  lastQR = qr;
  console.log('QR received, visit /qr to scan.');
});

client.on('ready', () => {
  console.log('WhatsApp client is ready');
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp client disconnected:', reason);
});

client.initialize();

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
