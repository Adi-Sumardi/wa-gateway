# SendaGo WA Gateway - Project Memory & System Knowledge

## Server & Infrastructure Details
- **Server IP**: `172.16.5.248`
- **SSH User**: `yapiar3`
- **Project Directory**: `/home/yapiar3/wa-gateway`
- **Public API Base URL**: `https://api-sendago.adilabs.id`
- **Frontend Dashboard URL**: `http://172.16.5.248:5173`
- **Docker Compose Containers**:
  - `sendago-backend` (Port 5001)
  - `sendago-gateway` (WhatsApp Puppeteer / whatsapp-web.js engine)
  - `sendago-frontend` (Port 5173 / Nginx)
  - `sendago-db` (PostgreSQL 17 on Port 5432)

---

## Integration Contract (API Usage)
- **Endpoint**: `POST https://api-sendago.adilabs.id/api/messages`
- **Headers**:
  - `Content-Type: application/json`
  - `X-API-KEY: <SENDAGO_API_KEY>`
- **Payload Body**:
  ```json
  {
    "to": "081234567890",
    "body": "[SendaGo WA] Kode OTP verifikasi Anda adalah 839201. Berlaku 5 menit."
  }
  ```
- **Application `.env` Template**:
  ```env
  SENDAGO_BASE_URL=https://api-sendago.adilabs.id
  SENDAGO_API_KEY=sg_7a377488dbfd3485632982210f44557e57b6b27fa089fbe3
  SENDAGO_DEVICE_ID=ea3cb9a8-a1c4-4dd9-913c-01bf0896b76e
  ```

---

## Critical Fixes Applied & Architectural Lessons
1. **`getNumberId()` Fallback in Gateway Engine (`gateway/src/index.ts`)**:
   - **Problem**: When `client.getNumberId(rawNumber)` returned `null` (due to WA Web store changes or privacy settings), the gateway threw an unhandled error, setting 344+ messages to `failed`.
   - **Fix**: Added a try-catch fallback. If `getNumberId` returns `null` or throws, it defaults to `${rawNumber}@c.us` and dispatches via `client.sendMessage(chatId, body)`.

2. **24/7 Transactional OTP Delivery (`docker-compose.yml`)**:
   - **Problem**: `SLEEP_ENABLED` defaulted to `true` (sleeping between 22:00 and 07:00), pausing OTP queue processing at night.
   - **Fix**: Added `SLEEP_ENABLED: "false"`, `MIN_SEND_DELAY: 1000` (1s), and `MAX_SEND_DELAY: 2500` (2.5s) to `docker-compose.yml`.

3. **Frontend Integration UI Upgrade (`frontend/src/App.tsx`)**:
   - Upgraded the **Settings -> API & Webhooks** menu with interactive API Key & Device ID selectors, a 1-click **Copy All .env** card, and auto-populated code snippets for Laravel/PHP, Node.js, Python, and cURL.
