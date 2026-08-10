# Microservices Cutover Runbook

`docker-compose.microservices.yml` stands up the full 11-service split described in
`SendaGo_WA_Architecture.md`, running **alongside** the existing monolith
(`docker-compose.yml`) — nothing about the old stack is touched until you
deliberately switch traffic over. This doc is that switch-over procedure.

## What's already done

- All 11 services + `api-gateway` are implemented under `services/`, each with
  its own Prisma schema, own Postgres database, own Dockerfile.
- Cross-service coordination runs over NATS (`services/_shared/events.ts`,
  copied into each service) plus direct internal HTTP calls
  (`/internal/...` routes) where a synchronous answer is needed (e.g.
  checking AI credit balance before replying).
- The AI Bot escalation feature (see the system review artifact) lives in
  `conversation-ai-service`, event-driven off `message.persisted`.
- Frontend (`VITE_API_URL` / `VITE_NOTIFICATION_URL`) and the WhatsApp worker
  (`gateway/`, via `BACKEND_URL`) are already repointable via env vars — no
  code changes needed to target either topology.
- Every service passes `tsc --noEmit` individually, and `identity-service` +
  `billing-service` were smoke-tested live (register → login → me, plus a
  cross-service quota lookup) against a local Postgres. **`docker compose up`
  itself has not been run in this environment** (no Docker daemon available
  here) — that's the first thing to do in yours.

## Before you start

- Docker + Docker Compose v2.
- Ports 5432 (shared with the monolith's Postgres unless you stop it first),
  4222 (NATS), 6000–6011, and 5174 free.
- Your `OPENAI_API_KEY` / `GEMINI_API_KEY` and Midtrans keys, same as the
  monolith's `.env`.

## Step 1 — Build and boot, verified in isolation

```bash
docker compose -f docker-compose.microservices.yml up --build
```

Watch for all 12 services + `nats` + `postgres` + `gateway` + `frontend`
reporting healthy. Hit each service's `/health` (e.g.
`curl localhost:6004/health` for conversation-ai) and `http://localhost:6000/health`
for the gateway itself.

Because it runs on different ports (`6000` vs `5001`, `5174` vs `5173`) and a
separate Postgres volume (`postgres_ms_data`), this is safe to run side by
side with the monolith — it has its own empty database, so create a fresh
admin user via `/api/auth/register` or reseed the permission matrix
(`identity-service` needs the same `Permission`/`RolePermission` seed rows the
monolith's `prisma/seed.ts` creates — port that seed script, or POST them
manually via `/api/permissions`).

## Step 2 — Functional pass against the new stack

Point a browser at `http://localhost:5174` (the microservices frontend build)
and walk the golden paths before touching real traffic:

1. Register/login, confirm `/api/auth/me` returns both identity fields and
   quota fields (proves the api-gateway composition works).
2. Link a device (QR flow) — proves `gateway/` ↔ `device-gateway-service`
   ↔ `notification-service` (QR push) chain.
3. Send/receive a WhatsApp message — proves
   `device-gateway → messaging → notification` and, if AI is enabled on the
   device, the full `conversation-ai` reply/escalation path from the system
   review.
4. Force an AI escalation (ask something outside the device's configured
   context) and confirm it shows up on the **AI Escalations** page live.
5. Run one broadcast, one warmer session, one credit top-up — exercises
   `campaign`, `warmer`, and `billing`'s cross-service calls end to end.

## Step 3 — Data migration (only when you're ready to cut real traffic)

The two topologies have **separate databases with no shared history** — this
is the part that's genuinely irreversible-feeling, so plan a maintenance
window:

1. Freeze writes to the monolith (maintenance page or read-only mode).
2. Export each domain's rows from the monolith's single Postgres and import
   into the corresponding service's database — a straight `pg_dump --table`
   / `pg_restore` per table, since the schemas are structurally identical
   (same column names/types, just redistributed across databases and with
   FKs to other domains dropped). Order doesn't matter much since there are
   no cross-database FK constraints to satisfy.
3. Re-run each service's `prisma migrate deploy` (or `db push`) against the
   *target* database first if you haven't already, then load the data.
4. Spot-check row counts per table match before and after.

## Step 4 — Traffic cutover

1. Update DNS / load balancer / reverse proxy to point the production
   hostname at `api-gateway` (port 6000) instead of the monolith's `backend`
   (port 5001), and the frontend build's `VITE_API_URL` /
   `VITE_NOTIFICATION_URL` to match.
2. Repoint the real WhatsApp worker's `BACKEND_URL` at `device-gateway`
   and let it re-link (or migrate its `.wwebjs_auth` session volume over —
   the session files are keyed by device ID, which doesn't change).
3. Watch error rates / `docker compose logs -f` across services for the
   first hour. Every service logs its own name as a prefix
   (`[identity]`, `[conversation-ai]`, ...), so `grep` by service is enough
   to isolate a problem.

## Step 5 — Decommission the monolith

Once the new stack has run real traffic cleanly for a few days:

```bash
docker compose down          # stop the old monolith + its gateway/frontend
```

Keep `docker-compose.yml`, `backend/`, and the monolith's Postgres volume
around (don't delete) for at least one full billing cycle in case a rollback
is needed — the monolith's `prisma/migrations` drift issue flagged in the
system review becomes moot once it's retired rather than patched.

## Rollback

Nothing here is one-way until Step 4. If Step 2 or 3 surfaces a real
problem, just leave the DNS/proxy pointed at the monolith and keep iterating
on `docker-compose.microservices.yml` — the two stacks not sharing a database
is exactly what makes this safe to abandon and retry.
