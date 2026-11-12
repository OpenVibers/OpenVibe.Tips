# AGENTS.md — OpenVibe.Tips

## Project overview

OpenVibe.Tips (`https://openvibe.tips`) is creator support: tips, goals, paid messages, TTS and media
requests, paid sounds, creator posts and overlays. It orchestrates Billing, Chat, Live and Media and
owns the **interaction**; money never lives here (ADR-012).

- **Entry:** `server/index.js`; app `server/app.js`; port `4610`, service id `tips`.
- **API:** `server/api/v1.js`, auth `server/api/auth.js`, idempotency `server/api/idempotency.js`,
  subject assertion `server/api/subject-assertion.js`, limits `server/api/actor-limits.js`.
- **Domain:** `server/domain/` — `interactions.js`, `goals.js`, `overlays.js`, `overlay-hub.js`,
  `sounds.js`, `paid messages`/`effects.js`, `posts.js`, `profiles.js`, `moderation.js`,
  `privacy.js`, `account-data.js`, `support-links.js`, `markdown.js`, `filter.js`.
- **Delivery and clients:** `server/delivery/` (chat adapter), `server/clients/live-now.js`,
  `server/vip/client.js`, `server/events/` (Billing inbox and outbox).
- **Pages:** `server/web/` (`pages.js`, `routes.js`, `layout.js`, `session.js`, `multipart.js`) renders
  the creator pages and overlays; `public/css` and `public/js` are small enhancements. No bundler.
- **Docs:** `docs/threat-review.md`; `npm run subscribe` creates the Events subscriptions.

## Owns, does not own

Owns `tip_interactions`, `creator_tip_profiles`, `tip_goals`, `tip_goal_contributions`,
`paid_messages`, `paid_media_requests`, `creator_sounds`, `overlay_configs`, `overlay_deliveries`,
`interaction_effects` (PostgreSQL `ov_tips`) — interaction state and **references to Billing
transaction ids, never a mutable cash balance** — and revocable scoped overlay tokens
(`overlay_tokens`, hashed at rest; never creator cookies).

Does not own: monetary accounting, prices, balances, refunds or payouts (Billing); chat rooms, TTS
synthesis and queues (Chat); media bytes and the media queue (Media/Live); identity (Network).

## Who calls it, what it calls

People use the pages and the API with their own Network Bearer token; services use a
client-credentials token for audience `openvibe.tips`, one capability per route. SDK
`openvibe-sdk/tips` is the client surface (`tip`, messages/TTS/media/sound, goals, receipts, overlay
tokens, export/erase). Tips calls Network (SSO, JWKS), Billing (checkout/intent,
entitlements/transactions), Events (subscriptions and the outbox), Chat (`TIPS_CHAT_ADAPTER=chat`
posts the chat lines/alerts), Live (channel goal/tip history) and Media (bytes). Billing's events
arrive signed (`TIPS_EVENTS_SECRET`) through an inbox that dedupes them.

## Database and migrations

PostgreSQL `ov_tips` through `openvibe-sdk/db` (PgBouncer for reads/writes, owner role for
migrations); Valkey holds shared state. Migrations `migrations/NNNN_*.sql` run at boot and are
**expand-only** until a contract release: never edit one that has run, never drop or rename a
column/table that an older release still reads. State lives in `/var/lib/openvibe-tips`.
Idempotency receipts are stored, not held in memory.

## Auth and idempotency

Network RS256 JWTs (JWKS) and SSO on the pages. **The API never reads cookies**: people present a
Bearer user token and act on their own things; services present a service token and the capability
for the route. Overlays use revocable, scoped tokens hashed at rest — never a creator cookie.
Every POST/PATCH carries `Idempotency-Key`; the key is claimed before the handler runs, so the same
key twice at once runs once and the second gets `409 idempotency.in_progress` with `Retry-After`
until the first answer is stored and replayed. `/internal/` and `/metrics` are never public.

## Deploy

`sudo ovhost deploy tips` (git-checkout: fetch, fast-forward `/opt/openvibe.tips`, install on a
lockfile change, restart, wait for `/api/ready`; rollback `sudo ovhost rollback tips --to <sha>`).
Unit `openvibe-tips.service` on `127.0.0.1:4610`, env `/etc/openvibe/tips.env`, nginx
`deploy/nginx/openvibe.tips.conf` (live since the 2026-10-17 launch).

## Commands and tests

```bash
npm ci
npm run dev                 # http://127.0.0.1:4610
npm test                    # every test/*.test.js, in-process stubs, temp DB
npm test -- overlays import # only matching files
npm run test:pg             # the same on PostgreSQL
npm run subscribe           # create the Events subscriptions once
```

`test/run.js` uses `openvibe-shared/test-runner` (60 s, serial); stubs of Network, Billing, Events
and Live, temp databases and random ports, never the network. Coverage includes billing-client
contracts, idempotency, the moderation/filter/markdown rules, overlays and their hub, delivery,
pages/empty states, open redirects, account data and the threat-review cases.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; problem+json errors and escaped HTML.
- **Tips never moves money.** It creates Billing intents/transfers and stores Billing ids; every
  balance, refund and payout question is Billing's. A local "balance" field is a bug.
- **Settlement is not interaction.** Always distinguish payment settled from interaction recorded;
  a failed/refunded payment must not leave a delivered paid message without its state.
- **Keep the idempotency claim** before any side effect, and store the answer for replay; a retry
  from Billing or the browser must not double-post a message, sound or tip.
- **Overlay tokens are revocable and hashed at rest.** Never put a creator session cookie in an
  overlay URL or log a token.
- **Billing events are signed and deduped**; an unsigned delivery is refused and a redelivery changes
  nothing.
- **Deleting a person does not delete the books:** the creator's settings/overlays/moderators go, the
  amount and its Billing reference stay, and a pending payment is kept for reconciliation.
- Paid content respects the moderation/filter rules in `server/domain/filter.js` and
  `moderation.js`; the API never trusts text or a media URL from the client.
