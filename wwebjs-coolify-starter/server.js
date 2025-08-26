const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Store the latest QR so you can view it in the browser
let lastQR = null;

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

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

// Create and initialise the WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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