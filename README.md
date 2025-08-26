# wwebjs-coolify-starter

A minimal Express server that uses `whatsapp-web.js` and shows the QR at `/qr`.
Persistent auth is stored in `./.wwebjs_auth` so make sure to mount a volume in Coolify at `/app/.wwebjs_auth`.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000/qr to scan
```

## Environment

- `PORT` optional, default 3000
- `PUPPETEER_EXECUTABLE_PATH` optional, default `/usr/bin/chromium`