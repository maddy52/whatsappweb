# WhatsApp Sender Gateway

Multi‑tenant WhatsApp sending API for your trainers. Each trainer links **one** WhatsApp number by scanning a QR once; the session then **persists across restarts and redeploys** via `LocalAuth` on persistent storage. Lovable calls this API to manage sessions and send messages.

## Base URL & Auth
- **Base URL:** `https://whatappi.growthgrid.me`
- **Auth:** All JSON endpoints require header `x-api-key: <API_TOKEN>`
- **Content-Type:** `application/json`

> Never hard-code the token in client code. Store it in Lovable’s server-side secrets and proxy it if you must call from the browser.

---

## Concepts
- **trainerId** — The unique id from your app (e.g., `trainer_123`). We keep a session per trainer.
- **QR & Ready** — After `POST /sessions`, visit `/sessions/:trainerId/qr` to display the QR. When the user scans with WhatsApp → Linked devices, the session becomes **ready**.
- **Persistence** — Sessions and cookies are stored on a mounted volume so they survive container restarts/redeployments.
- **Disconnect** — Trainer can logout at any time; a new QR is then required.
- **Send** — When `ready:true`, send text messages using `POST /sessions/:trainerId/send`.

---

## Endpoints

### 1) Health
```
GET /healthz
```
**200** → `ok` (no auth).

---

### 2) Create / Init Session
```
POST /sessions
Headers: x-api-key: <API_TOKEN>, Content-Type: application/json
Body:    { "trainerId": "trainer_demo" }
```
**200**
```json
{ "ok": true, "trainerId": "trainer_demo" }
```

**Notes**
- If the trainer is already linked, this is idempotent and keeps the session.
- If not linked, a QR will become available shortly at `/sessions/:trainerId/qr`.

**Example (curl)**
```bash
curl -X POST "https://whatappi.growthgrid.me/sessions"   -H "x-api-key: YOUR_API_TOKEN" -H "Content-Type: application/json"   -d '{"trainerId":"trainer_demo"}'
```

---

### 3) Show QR (HTML)
```
GET /sessions/:trainerId/qr
```
Returns **200 HTML** with the QR when ready; **404** while QR is not yet available.
Recommended UI: show an iframe that reloads every 2–3 seconds until it returns 200.

```html
<iframe src="https://whatappi.growthgrid.me/sessions/trainer_demo/qr" width="380" height="420"></iframe>
```

---

### 4) Session Status
```
GET /sessions/:trainerId/status
Headers: x-api-key: <API_TOKEN>
```
**200**
```json
{ "ready": true, "qrAvailable": false, "lastError": null }
```
- Use to drive the Settings screen: **Connect** → **Connected** → **Disconnect**.

**Example**
```bash
curl -H "x-api-key: YOUR_API_TOKEN" "https://whatappi.growthgrid.me/sessions/trainer_demo/status"
```

---

### 5) Send Text Message
```
POST /sessions/:trainerId/send
Headers: x-api-key: <API_TOKEN>, Content-Type: application/json
Body: { "to": "9715XXXXXXXX", "text": "Hello from Lovable!" }
```
**200**
```json
{ "ok": true, "id": "3EB059AEBA0A39C15D88A0", "to": "9715XXXXXXXX@c.us" }
```

**Errors**
- **404** → `{ "error":"number is not on WhatsApp" }`
- **503** → `{ "error":"session not ready" }`

**Example**
```bash
curl -X POST "https://whatappi.growthgrid.me/sessions/trainer_demo/send"   -H "x-api-key: YOUR_API_TOKEN" -H "Content-Type: application/json"   -d '{"to":"9715XXXXXXXX","text":"Invoice #123 is ready"}'
```

---

### 6) Logout (Disconnect)
```
POST /sessions/:trainerId/logout
Headers: x-api-key: <API_TOKEN>
```
**200** → `{ "ok": true }`.

---

### 7) Delete Session (Admin Reset)
```
DELETE /sessions/:trainerId?purge=true
Headers: x-api-key: <API_TOKEN>
```
**200**
```json
{ "ok": true, "purged": true }
```
- `purge=true` wipes persistent auth files so the next init forces a **new QR**.

---

### 8) List Active Sessions (in-memory)
```
GET /sessions
Headers: x-api-key: <API_TOKEN>
```
**200**
```json
{ "sessions": [ { "trainerId": "trainer_demo", "ready": true, "qrAvailable": false, "lastError": null } ] }
```

---

## Lovable Integration Guide

### Settings → WhatsApp
1. If not connected, show **Connect WhatsApp** button.
2. On click: `POST /sessions` with `{ trainerId }`.
3. Render the QR iframe: `GET /sessions/:trainerId/qr` (poll/reload 2–3s).
4. Poll `/status` every 2–3s; when `ready:true`, hide the QR and show **Connected** + **Disconnect**.
5. **Disconnect** calls `POST /sessions/:trainerId/logout`.

### Sending notifications via WhatsApp
- Add a toggle **“Also send via WhatsApp”** to your existing notifications.
- When enabled and session is `ready:true`, call `POST /sessions/:trainerId/send` with the recipient’s international number (digits only) and message text.
- Fallback to SMS/email if status is not ready.

### Security
- Keep the gateway behind HTTPS (Traefik + Cloudflare already set).
- Use one **server-side stored** API key. Do not expose it to the browser.
- Consider a Lovable backend endpoint (proxy) that authenticates the trainer and forwards requests with the API key.

---

## Example TypeScript Client
See [`lovable-client.ts`](./lovable-client.ts) for a minimal fetch-based wrapper.
