const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

let lastQR = null;
let ready = false;
let lastError = null;

// --- Health ---
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// --- QR page ---
app.get('/qr', async (_req, res) => {
  if (!lastQR) return res.status(404).send('QR not available yet. Refresh after you see "QR received" in Logs.');
  try {
    const dataUrl = await QRCode.toDataURL(lastQR);
    res.set('Content-Type', 'text/html').send(`
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1"/></head>
        <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
          <h2>Scan this with WhatsApp on your phone</h2>
          <img src="${dataUrl}" alt="QR" style="max-width:360px;width:100%;height:auto;border:1px solid #ddd;border-radius:12px;padding:8px"/>
          <p>WhatsApp → Settings → Linked devices → Link a device.</p>
        </body>
      </html>
    `);
  } catch {
    res.status(500).send('Failed to render QR.');
  }
});

// --- Status/debug ---
app.get('/status', (_req, res) => res.json({ ready, qrAvailable: !!lastQR, lastError }));

// --- Re-init without clearing auth ---
app.get('/reinit', async (_req, res) => {
  try { await safeDestroy(); initClient(); res.json({ ok: true, msg: 'Client reinitialising' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Logout to force a new QR (clears current session) ---
app.get('/logout', async (_req, res) => {
  try {
    if (global._wwebClient) await global._wwebClient.logout();
    await safeDestroy(); initClient();
    res.json({ ok: true, msg: 'Logged out; new QR will be generated.' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Simple send endpoint ---
// /send?to=9715XXXXXXXX&text=Hello
app.get('/send', async (req, res) => {
  try {
    if (!ready) return res.status(503).json({ ok: false, error: 'Client not ready' });
    const to = (req.query.to || '').replace(/\D/g, '');
    const text = req.query.text || '';
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    const sent = await global._wwebClient.sendMessage(`${to}@c.us`, text);
    res.json({ ok: true, id: sent.id.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }), // persisted on your volume
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      // IMPORTANT: do NOT set userDataDir and do NOT pass --user-data-dir when using LocalAuth
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

  client.on('qr', (qr) => { lastQR = qr; console.log('QR received, visit /qr to scan.'); });
  client.on('ready', () => { ready = true; console.log('WhatsApp client is ready'); });
  client.on('disconnected', (reason) => { ready = false; console.log('WhatsApp client disconnected:', reason); setTimeout(initClient, 5000); });
  client.on('message', (msg) => console.log('RECV:', msg.from, msg.body));

  return client;
}

async function safeDestroy() {
  try { if (global._wwebClient) await global._wwebClient.destroy(); } catch {}
  global._wwebClient = null; ready = false; lastQR = null;
}

function initClient() {
  global._wwebClient = createClient();
  lastError = null;
  global._wwebClient.initialize().catch((err) => {
    lastError = err && err.message ? err.message : String(err);
    console.error('Client initialize failed:', lastError);
    setTimeout(initClient, 5000);
  });
}

initClient();

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
