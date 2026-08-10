# SendaGo WA Architecture

> Reflects what is actually implemented under `services/` +
> `docker-compose.microservices.yml`, not an aspirational plan. See
> `MICROSERVICES_CUTOVER.md` for how to boot it and cut real traffic over
> from the legacy monolith (`backend/` + `gateway/` + `frontend/`, still the
> system of record until that cutover happens).

## Vision

**Reliable WhatsApp Messaging Platform for Developers & Businesses**

SendaGo WA provides a unified API for WhatsApp messaging, broadcast
campaigns, WA number warming, customer engagement, and an AI auto-reply bot
that hands off to a human operator the moment it can't confidently answer.

## High Level Architecture

``` text
Dashboard (React/Vite)          WhatsApp Worker (whatsapp-web.js)
            │                              │
            ▼                              ▼
      API Gateway (:6000)          device-gateway (:6002)
            │                              │  hosts the worker's
────────────────────────────────────────   │  socket.io connection
identity          (:6001)                  │
device-gateway    (:6002) ◄─────────────────
messaging         (:6003)
conversation-ai   (:6004)
notification      (:6005) ── hosts the dashboard's socket.io connection
contact           (:6006)
template          (:6007)
campaign          (:6008)
billing           (:6009)
warmer            (:6010)
audit             (:6011)
────────────────────────────────────────
NATS (event bus)
────────────────────────────────────────
PostgreSQL - one database per service
────────────────────────────────────────
WhatsApp Web (via whatsapp-web.js / Puppeteer)
```

Two coordination paths, used deliberately for different needs:

-   **Events over NATS** for anything another service should react to but
    doesn't need an answer from (`message.persisted`, `device.status.changed`,
    `ai.escalation.created`, `quota.updated`, ...). `notification-service`
    subscribes to nearly all of them and is the only place that turns an
    event into a live dashboard push or an outbound webhook call.
-   **Direct internal HTTP** (`GET/POST /internal/...`, no auth - trusted
    network only) when a service needs a synchronous answer before it can
    proceed - e.g. `conversation-ai` checking AI credit balance with
    `billing` before generating a reply, or `campaign` resolving a device's
    connection status with `device-gateway` before dispatching.

## Services

### identity

-   Login/register, JWT issuance
-   Users, roles, granular permission matrix (`role_permissions`)
-   API keys for the public send API
-   `/internal/permissions/check`, `/internal/users/:id`,
    `/internal/apikeys/validate` — called by every other service and by
    `api-gateway`

### device-gateway

-   Device CRUD, QR pairing, connection status
-   Hosts the Socket.io endpoint the `whatsapp-web.js` worker process
    (`gateway/`) connects to - the only service that speaks the raw WA
    worker protocol
-   Turns raw worker events into domain events (`message.received`,
    `device.status.changed`, `message.ack.received`) instead of any other
    service needing to know that protocol exists
-   `/internal/devices/:id/send` - the one place a message actually gets
    pushed to WhatsApp

### messaging

-   Owns the `messages` table; persists inbound messages off
    `message.received`, applies delivery ACKs off `message.ack.received`
    with an out-of-order/terminal-state guard
-   Public send API (`POST /messages`, used by API-key integrations)
-   Notifies `campaign` when an ACK belongs to a broadcast target, and
    `warmer` when an ACK belongs to warmer chatter instead of a real message

### conversation-ai

-   The AI auto-reply bot, event-driven off `message.persisted`
-   **Escalates to a human instead of guessing** on two conditions: a
    technical failure calling OpenAI/Gemini, or the model itself signaling
    (`NEED_HUMAN` sentinel) that it lacks the context to answer confidently
    - order status, refunds, complaints, anything outside the device's
    configured business context
-   Neither escalation case is billed as AI credit; both send the customer a
    holding reply and raise an `AiEscalation` row + `ai.escalation.created`
    event for a human operator to pick up
-   Owns `ai_escalations`; exposes `GET/POST /ai-escalations` for the
    dashboard's **AI Escalations** page

### notification

-   Hosts the Socket.io endpoint the dashboard connects to
-   Subscribes to nearly every event in the system and turns each into
    either a live push (`emitToOwner`, scoped to the owning user's room +
    the `admin` room) or an outbound webhook call (owns `webhooks` /
    `webhook_logs`)
-   The one service that has to know every event name that exists

### contact

-   Contacts, contact groups/membership
-   `/internal/contacts/find-or-create`, `/internal/contacts?ids=` (batch) -
    called constantly by device-gateway, messaging, campaign, conversation-ai

### template

-   Saved message templates (name, content, media)

### campaign

-   Broadcasts, broadcast targets, dispatch scheduling (delay/sleep window,
    device rotation)
-   Leads (landing page "Hubungi Kami" form)
-   Link shortener + click tracking

### billing

-   Every meterable quota in one place: AI credit balance, broadcast quota,
    warmer slot limit, device slot limit (`user_quotas`)
-   AI credit ledger, credit packages, credit orders, bundle packages/orders,
    Midtrans Snap integration + webhook signature verification
-   `/internal/quota/:userId/ai-credit/check` and `/consume` - the two calls
    that gate and meter every AI Bot reply

### warmer

-   WA number warming: paired devices exchange scripted messages on a
    randomized schedule to build sender reputation

### audit

-   The only service that writes to `audit_logs` - every other service
    publishes `audit.logged` instead of writing directly, so it stays a
    single source of truth

### api-gateway

-   Public entrypoint (`:6000`); routes `/api/*` to the owning service,
    stripping the `/api` prefix
-   Resolves `X-API-KEY` integration requests into the same JWT shape every
    service's `authenticateJWT` already expects, so API-key auth is a
    gateway-only concern
-   Composes `GET /api/auth/me` from `identity` (core fields) + `billing`
    (quota fields) into one response, since the dashboard expects both

## Public APIs

-   `POST /api/messages` - send a message (JWT or `X-API-KEY`)
-   `GET /api/messages` - message history
-   `GET /api/contacts`
-   `POST /api/broadcasts`
-   `POST /api/webhooks` - register a webhook subscription
-   `GET /api/ai-escalations` - conversations the AI Bot handed off to a human

## Event catalog (NATS)

  Event                        Producer          Key consumers
  ----------------------------  ----------------  ---------------------------------
  `message.received`            device-gateway    messaging
  `message.persisted`           messaging         conversation-ai, notification
  `message.ack.received`        device-gateway    messaging
  `message.status.updated`      messaging         notification
  `device.status.changed`       device-gateway    notification
  `device.qr.generated`         device-gateway    notification
  `ai.escalation.created`       conversation-ai   notification
  `ai.credit.depleted`          conversation-ai   notification
  `quota.updated`               billing           notification
  `broadcast.status.changed`    campaign          notification
  `warmer.log.created`          warmer            notification
  `audit.logged`                every service     audit

## Database

One PostgreSQL database per service (same instance, separate `CREATE
DATABASE`, provisioned by `services/_infra/init-multi-db.sh`) - no
cross-database foreign keys; cross-service references are plain UUID columns
resolved via `/internal/...` calls. No Redis/MinIO/ClickHouse yet - not
needed by anything currently built.

## Tech Stack

  Layer            Technology
  ----------------  --------------------------------
  Services          Node.js + TypeScript + Express
  ORM               Prisma (one schema per service)
  Event bus         NATS
  Database          PostgreSQL (one DB per service)
  Frontend          React + Vite
  WhatsApp worker   whatsapp-web.js (Puppeteer)
  Container         Docker + Docker Compose

Chosen to match the stack the legacy monolith already used (Node/TS/Prisma/
React), rather than introducing Go/Laravel/Next.js/Kafka/Kubernetes for a
system at this scale - see the system review artifact for the migration
phasing rationale (NATS over Kafka, no k8s yet, etc).

## Status

-   **Shipped in the monolith** (`backend/` + `gateway/` + `frontend/`,
    still the system of record): AI Bot escalation-to-human feature, the bug
    fixes it depended on.
-   **Built, individually verified (`tsc --noEmit` clean on all 12
    services), not yet load-bearing**: the full service split above. See
    `MICROSERVICES_CUTOVER.md` for the boot → functional-pass → data
    migration → traffic cutover → decommission sequence before this becomes
    the system of record.
