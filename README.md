# OpenVibe.Tips

> Creator support: tips, goals, paid messages, TTS and media requests, overlays.

**Status:** alpha — runtime built and tested against stubs (roadmap Wave 9). Deployed internally, not
launched: running on the host since 2026-09-23 on `127.0.0.1:4610` only, with no
creator profile yet, with no public route. OpenVibe.Live remains where tips happen until the Billing cutover (see *What waits*).
Data: PostgreSQL through PgBouncer, and Valkey for shared state ([ADR-035](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-035-postgresql-and-valkey.md));  
**Domain:** `openvibe.tips` (keeps its OpenVibe.Sites placeholder until the launch rule below holds)  
**Port / service id:** 4610 / `tips`  
**Decision:** [ADR-012](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-012-economic-classification.md) — Tips never moves money; Billing does.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §11.2; roadmap Wave 9, §15.11, §29.  
**License:** AGPL-3.0.

## Purpose

A creator product that orchestrates Billing, Chat, Live and Media. Settlement is Billing's; Tips owns
the interaction, goals, overlays and creator configuration, and always distinguishes *payment settled*
from *interaction delivered*.

## Owns

- `tip_interactions`, `creator_tip_profiles`, `tip_goals`, `tip_goal_contributions`, `paid_messages`,
  `paid_media_requests`, `overlay_configs`, `overlay_deliveries`, `interaction_effects`
  (its own PostgreSQL database `ov_tips`, schema in [migrations/](migrations/), access in `server/db.js`) —
  interaction state and **references** to Billing transaction ids, never a mutable cash balance
- revocable scoped overlay tokens (`overlay_tokens`, hashed at rest; never creator cookies)

## Does not own

- monetary accounting, prices, balances, refunds, payouts (OpenVibe.Billing)
- chat rooms, TTS synthesis and queues (OpenVibe.Chat; Live's chat server until Chat's cutover)
- media bytes and the media queue (OpenVibe.Media / Live)
- identity (OpenVibe.Network)

## Depends on

- **PostgreSQL 18 through PgBouncer (transaction mode) and Valkey 9** — OpenVibe.Host's data role
  (`roles/data/add-service.sh tips`: database `ov_tips`, owner and runtime roles, a Valkey user on
  `ov:tips:*`). PostgreSQL is required (the system of record); Valkey holds only what the processes share
  (per-actor limit counters, overlay fan-out, overlay stream slots) and its loss changes no answer about money
- **OpenVibe.Billing** — `POST /api/v1/intents` (checkout), `POST /api/v1/transfers` (a tip from credit),
  `billing.transaction.settled|reversed` events, and `billing.receipt.external` (a tip on a creator's own
  PowerChat, once Billing receives the PowerChat webhook)
- **OpenVibe.Events** — Billing's events in (signed webhook + openvibe-sdk inbox), Tips' events out
  (openvibe-sdk transactional outbox)
- **OpenVibe.Network** — SSO for people, service tokens, JWKS, identity resolve (a creator's Chat room)
- **OpenVibe.Chat** — chat delivery through its typed ingress (`/internal/chat/messages`, `/internal/chat/events`)
- **OpenVibe.Live** — overlay consumer
- **OpenVibe.Shared** v2.2.0 (app icon, SSR footer, noscript nav, release manifest, legal pages, boost page moves) and
  the Network's `navbar.js`; **openvibe-contracts** v0.79.0 and **openvibe-sdk** v0.28.0 (service tokens,
  the async data layer `openvibe-sdk/db`, the PostgreSQL outbox and inbox — the events outbox is the SDK's
  `createServiceOutbox`, plan T1 — Valkey, pub/sub and the shared limit store), pinned by release tarball;
  `pg` and `iovalkey` (drivers), PGlite for tests

## Capabilities

Implemented here (the service manifest's `capabilities`, 18 `tips.*` ids, audience `openvibe.tips`):
`tips.profile.get|update`, `tips.checkout.create`, `tips.superchat.create`, `tips.tts.request`,
`tips.media_request.create`, `tips.interaction.get|list|record|moderate`, `tips.goal.create|update|close`,
`tips.overlay.token.create|revoke`, `tips.overlay.config.get|update` and `tips.simulation.run`.

Called elsewhere, as the service principal `tips`:

| Service | Grant | Why |
|---|---|---|
| OpenVibe.Billing | `billing.intent.create`, `billing.transfer.create` | checkout, and a tip from credit |
| OpenVibe.Events | `events.event.publish`; `events.subscription.manage` (`npm run subscribe`, and at boot) | the outbox relay; the `billing.transaction.*` and `billing.receipt.*` subscriptions; the two account subscriptions (created at boot when missing) |
| OpenVibe.Network | `network.account.export.contribute`, `network.account.deletion.confirm` (granted last, once this release is live) | account export and deletion (ADR-033) |
| OpenVibe.Chat | `chat.message.send`, `chat.event.publish` (only with `TIPS_CHAT_ADAPTER=chat`) | donation lines and TTS through `/internal/chat/messages`, the alert through `/internal/chat/events` |
| OpenVibe.Network | `identity.subject.resolve` (only with `TIPS_CHAT_ADAPTER=chat`) | the creator's Live user id (Chat's room) from `/internal/identity/resolve` |

## Run it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env            # OV_OAUTH_CLIENT_SECRET, TIPS_FORM_SECRET, TIPS_EVENTS_SECRET, …
npm run dev                     # http://localhost:4610 (without DATABASE_URL: an embedded PGlite database in data/pglite)
npm test                        # every test/*.test.js: stub Network/Billing/Events/Chat, PGlite, random ports
eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)"   # PostgreSQL 18 + PgBouncer + Valkey 9 containers
npm test                        # … now also test/integration.test.js on the containers
npm run test:pg                 # every test file through PgBouncer and Valkey
npm run subscribe               # create the billing.transaction.* and billing.receipt.* subscriptions in OpenVibe.Events
```

Production (deployed, loopback only): `/opt/openvibe.tips`, env `/etc/openvibe/tips.env`, unit
[deploy/systemd/openvibe-tips.service](deploy/systemd/openvibe-tips.service) (state in `/var/lib/openvibe-tips`).
The vhost [deploy/nginx/openvibe.tips.conf](deploy/nginx/openvibe.tips.conf) is not installed yet:
`openvibe.tips` still serves the Sites placeholder.

## Design

**Two state machines per interaction** (`server/domain/interactions.js`):

```
payment_state   pending ──► settled ──► reversed        mirrored from Billing, keyed by billing_txn_id (UNIQUE)
                       └──► failed
delivery_state  awaiting_payment ──► queued ──► delivered | failed | cancelled
```

A delivery failure (Chat down, chat refused) is retried with backoff and finally recorded on the
effect; it never touches `payment_state`. A reversal after delivery flips `payment_state` and keeps the
delivery record; a reversal before delivery cancels the queued effects (`tips.interaction.cancelled`).

**How money moves** (it never moves in Tips):

| Funding | What Tips asks Billing | Settles when |
|---|---|---|
| `credit` | `POST /transfers {from: supporter, to: creator, kind: tip\|paid_interaction, target: {service: tips, type: interaction, id}}`, `Idempotency-Key: tips:transfer:<id>` | the response (the settled event for that transaction is then a no-op) |
| `checkout` | `POST /intents {kind: purchase, subject: supporter, bits: amount}`, key `tips:intent:<id>` → checkout URL | the purchase's `billing.transaction.settled` (metadata.intent_id) triggers the transfer above — CREDIT becomes MONEY only by giving it (ADR-012 rule 3) |
| `provider` / origin `billing` | nothing — a donation settled in Billing that Tips did not start (Live's donate flow, a site-routed PowerChat tip) | recorded once by its Billing transaction id; overlay + goals, no second chat line |
| `external` | nothing — a tip on the creator's own PowerChat (ADR-012 EXTERNAL) | `POST /api/v1/interactions/external`, or Billing's `billing.receipt.external` (origin `billing-external`: Tips posts the chat line — `… tipped N Vibes: msg (PowerChat)` — plus overlay alert and goal, as Live's webhook did); once per (provider, provider_ref); never in Billing totals |
| `none` (simulation) | nothing | at once, `test = 1`: full effect path, no goal contribution, no durable event, excluded from totals |

**Exactly one logical interaction:** the inbox claims `(consumer, event_id)` in the same serializable
transaction as the change, so a redelivered event does nothing; `billing_txn_id` is UNIQUE, so the same
Billing transaction under another event id (republish, replay) is still one interaction; API calls carry
`Idempotency-Key` (stored responses + the interaction's own unique key); the no-JS form carries a nonce.

**Settlement** writes, in one transaction: the `paid_messages` / `paid_media_requests` row (these never
exist before settlement), the goal contribution (goal the supporter picked, else the creator's only active
goal — Live's rule), the overlay alert, the `interaction_effects`, and `tips.interaction.ready`.

**Goals** are derived: `current = Σ(contribution − reversed)`, plus `opening_amount` for goals imported
from Live (whose `current_amount` cannot be traced to individual donations).

**Totals** (`GET /api/v1/profiles/:creator/totals`): `settled_via_billing` (settled or imported, non-test,
minus what Billing took back) — the number that must equal Billing's books — with `external` and
`simulations` reported apart.

**Data** (ADR-035; `server/db.js`, [migrations/](migrations/)):
- Everything is async on `openvibe-sdk/db`: a function that touches the database takes the query handle
  first (`db`, or the transaction's `t`), and after-commit work (overlay pushes, worker kicks) hangs on
  the transaction (`t.after`). The schema is `migrations/NNNN_*.sql` (expand/migrate/contract), applied
  at boot with the owner role; the service then serves through PgBouncer with no session state.
- **Money paths are SERIALIZABLE with row locks** (ADR-007 amendment 2026-09-24, rule 3): a request and
  its unpaid-checkout limit, settlement (paid message, media request, goal contribution), payment failure,
  funding, reversal, the Billing inbox, and what cancels or releases what a payment bought (moderation's
  hide and restore, the effects worker's writes). Locks are taken in one order: a creator's profile row
  (settings changes and per-creator limits), the interaction row, its goals by id, the creator's overlay
  stream (an advisory lock, so a creator's deliveries commit in seq order), then the rest. Serialization
  failures and deadlocks are retried by the data layer.
- Text is made storable on the way in: PostgreSQL keeps no NUL character, and jsonb no unpaired surrogate,
  so they are dropped or replaced (U+FFFD) in what people and Billing's events send.
- **Background work runs in every process** and claims its rows: due effects and due transfers with a
  lease (`FOR UPDATE SKIP LOCKED`, the lease in `next_attempt_at` / `next_transfer_at`), the overlay
  window sweep with `SKIP LOCKED`, the outbox relay by the SDK's lease; prunes are idempotent deletes.
- **Shared state in Valkey** (none of it authoritative): per-actor limit counters (the SDK's shared limit
  store), overlay fan-out (`overlay:<creator>` on pub/sub: a stream in one process hears a tip, a config
  change, a retraction or a revocation made in another), overlay stream slots (a sorted set per creator,
  refreshed by heartbeats). Without `VALKEY_URL` each process keeps its own, which is right for one process.
- Every query shape has an index (`test/migrations.test.js` checks the plans), lists page by keyset, and a
  list costs a fixed number of queries whatever its size (`test/query-budget.test.js`).

## API

`/api/v1`, problem+json errors, `Idempotency-Key` on every POST/PATCH (claimed before the handler runs:
the same key twice at once runs once, the other answered `409 idempotency.in_progress` with `Retry-After`
until the first answer is stored and replayed). Services present a Network
service token (audience `openvibe.tips`, one capability per route); people present their Network user
token as a Bearer and act on their own things only. The API never reads cookies.

| Method & path | Capability (services) | People |
|---|---|---|
| `GET /profiles/:creator` | `tips.profile.get` (switched-off pages) | anyone when the page is on; the owner |
| `PATCH /profiles/:creator` (`me` creates it) | `tips.profile.update` | owner |
| `GET /profiles/:creator/totals` | `tips.interaction.list` | owner |
| `POST /checkout` `{creator, amount, message?, goal_id?, pay_with: credit\|checkout, provider?, supporter (services), target?, privacy?}` | `tips.checkout.create` | the supporter |
| `POST /paid-messages` | `tips.superchat.create` | the supporter |
| `POST /tts-requests` `{…, tts: {text, voice}}` | `tips.tts.request` | the supporter |
| `POST /media-requests` `{…, media: {url}}` | `tips.media_request.create` | the supporter |
| `GET /interactions/:id` | `tips.interaction.get` | its creator or supporter |
| `GET /interactions?creator=\|supporter=&cursor=` | `tips.interaction.list` | own receipts; `?as=creator` own tips |
| `POST /interactions/external` `{creator, provider, provider_ref, amount_cents, supporter_name?, message?, announce?}` | `tips.interaction.record` | — |
| `GET /goals?creator=`, `GET /goals/:id` | `tips.goal.update` (private; full view) | public shape when the page is on (the creator's page settings); owner sees contributions |
| `GET /profiles/:creator/supporters` | `tips.profile.get` (while not public) | public when the creator shows the supporters page; the owner |
| `GET /me/export`, `POST /me/erase` | — (people only) | the supporter's own tips: download; erase their data from them |
| `GET /moderation?creator=&state=held\|hidden\|visible\|all` | `tips.interaction.moderate` | the creator and their moderators |
| `POST /interactions/:id/hide`, `POST /interactions/:id/restore` `{reason?}` | `tips.interaction.moderate` | the creator and their moderators |
| `GET /moderation/log?creator=` | `tips.interaction.moderate` | owner |
| `GET\|POST /moderators`, `POST /moderators/:subject/remove` | `tips.profile.update` | owner |
| `POST /goals`, `PATCH /goals/:id`, `POST /goals/:id/close` | `tips.goal.create` / `.update` / `.close` | owner |
| `GET\|POST /overlay-tokens`, `POST /overlay-tokens/:id/revoke` | `tips.overlay.token.create` / `.revoke` | owner |
| `GET /overlay-configs[/:id]`, `POST /overlay-configs`, `PATCH /overlay-configs/:id` | `tips.overlay.config.get` / `.update` | owner |
| `POST /simulate` | `tips.simulation.run` | owner |
| `POST /internal/events` | Events webhook signature (`TIPS_EVENTS_SECRET`), loopback only | — |

`tips.interaction.moderate` was proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/)
and is registered in openvibe-contracts v0.32.0.
The capabilities and the service manifest were released in openvibe-contracts v0.15.0 (3-segment ids:
the charter's `tips.simulate` is `tips.simulation.run`; `tips.interaction.record` is new, for EXTERNAL
tips); the drafts stay in [docs/capabilities-proposal/](docs/capabilities-proposal/) and
[docs/service-manifest-proposal.json](docs/service-manifest-proposal.json). Grants are matched with
contracts' `capabilities.grants()` (exact id or a `.*` family). Tips pins openvibe-contracts v0.33.0,
which also carries the payload schemas of the six `tips.*` events below (v0.30.2) and of
`tips.interaction.moderated|erased` (v0.32.0); `test/contracts.test.js` validates every envelope and
payload Tips produces against them.

## Privacy

What a supporter lets the public see is their choice, per tip (`privacy: { anonymous, hide_amount,
private_message }` on the API, three boxes on the tip form), stored on the interaction
([server/domain/privacy.js](server/domain/privacy.js)):

| Choice | Overlays, chat lines, public pages, other products | The creator | Events (internal) |
|---|---|---|---|
| `anonymous` | "Anonymous", no subject | "Anonymous", no subject | `supporter: null`, `supporter_name: "Anonymous"` |
| `hide_amount` | no amount (`amount: null`, the line reads "sent a tip"); off the leaderboard | the amount (their money) | the amount (goals and reconciliation need it) |
| `private_message` (tips only) | no message | the message | no message is ever in an event |

Only the supporter (their receipts, `GET /me/export`) and Billing (which moved the money) can link an
anonymous tip to them. `publicView()` is the one shape that leaves Tips for the public: overlay alert
payloads, chat jobs (which also carry `privacy`), the supporters and goals pages, and the `public` block
of every API answer. A goal bar still moves by a hidden amount, so the goal update of such a tip names
nobody.

**What the creator's public pages show** is theirs to choose (`page` on the profile, the dashboard's
*Public pages*): goal amounts or the percentage only, each goal's latest supporters, and a supporters
page (`/<handle>/supporters`, off by default) with the top supporters, their totals and recent public
messages. The leaderboard counts only tips whose supporter kept both name and amount public.

**Export and erasure.** `GET /me/export` (and `/receipts/export`) downloads everything Tips holds about a
supporter's tips. `POST /me/erase` (and `/receipts/erase`, with a confirmation) removes the person from
every settled, failed or reversed tip — subject, name, message, TTS text, media link, checkout reference,
stored API answers, overlay payloads, unsent events — and keeps the money record (amount, creator, date,
Billing transaction, goal contribution), so Billing's books and the creators' totals still reconcile.
Tips still waiting for their payment are kept until it settles or fails. Each erased interaction emits
`tips.interaction.erased`, whose `redacts` has OpenVibe.Events tombstone Tips' earlier events about it.
Stored API answers (Idempotency-Key replays) are pruned after a week.

**Account export and deletion (ADR-033).** `network.account.export_requested` and `network.account.deleted`
arrive at `POST /internal/events` and are answered by `server/domain/account-data.js` (`openvibe-sdk/account-data`),
outside the money inbox, with one receipt per export and deletion in `account_data_events`.

- **As a supporter:** the export is `/me/export`'s, and the deletion is the erasure above.
- **As a creator:** the export adds their settings, overlays (never a token hash), goals, the tips they received
  (without the supporters) and their moderators. The deletion removes their settings and page, overlays, overlay
  tokens and alert history, moderator list and invitations, and the stored answers that name them. The tips they
  received, the paid messages and media requests on them, their goals and their moderation log are kept and counted
  as retained.
- **As a moderator:** their moderator rows go; the moderation log keeps naming them.

## Moderation

[server/domain/moderation.js](server/domain/moderation.js), [server/domain/filter.js](server/domain/filter.js).
The money is never touched: hiding a paid message does not refund it, and a hidden tip still counts
toward its goal and the creator's totals.

- **Word filter** (`filter: { words, action, links }` on the profile, the dashboard's *Moderation* card;
  the list is the creator's only). Blocked words or phrases match whole, in any letter case, after
  Unicode NFKC folding and with invisible and direction-override characters removed, in the name and in
  what is shown or read. `mask` (default) stars them out of overlays, chat lines and pages and leaves
  them out of what text-to-speech reads; `hold` holds a paid message that matches before anything is
  shown, posted or read, until the creator or a moderator shows it (then it is released as settlement
  would have released it, still masked). Links in paid messages read `[link]` unless the creator turns
  that off.
- **Hide / show.** The creator, their moderators and services with `tips.interaction.moderate` hide a
  paid message: its queued chat, TTS and media deliveries are cancelled (never delivered), its overlay
  alert is retracted (connected overlays get a `retract` event and drop it, replays and `/state` skip
  it) and public pages leave it out. Showing it again puts it back on pages and in overlay state; what
  the hide cancelled stays cancelled. `/moderate/<handle>` is the review page (held, shown, hidden).
- **Moderators** are added by the creator: a show-once invitation link from the dashboard (hashed at rest,
  single use, 7 days, never in nginx's log), accepted signed in; or `POST /moderators` by the creator or
  a service. Moderators see what was written but never private messages, hidden amounts or payments.
- Every outcome is in `tip_moderation_log` (with the moderator and their note) and is published as
  `tips.interaction.moderated` (below), which carries no supporter, message, note or moderator.

## Events

Produced through the openvibe-sdk outbox (table `tips_event_outbox`, source `tips`, same transaction as
the change; relayed by any process, rows claimed with a lease, when `EVENTS_URL` and the client secret are set): `tips.interaction.ready`,
`tips.interaction.failed`, `tips.interaction.cancelled`, `tips.goal.updated`, `tips.overlay.delivered`,
`tips.overlay.failed`, and two whose schemas were proposed in [docs/events-proposal/](docs/events-proposal/)
and are in openvibe-contracts since v0.32.0: `tips.interaction.erased` (a supporter's erasure; `{ interaction_id,
creator, erased_at, redacts }`) and `tips.interaction.moderated` (`{ interaction_id, creator, action:
filtered|held|hidden|restored, by: filter|creator|moderator|service, moderation_state, cancelled_effects }`).
Simulations and Billing test money produce none. An anonymous supporter is never named in an event.
Consumed:
`billing.transaction.settled`, `billing.transaction.reversed`, `billing.receipt.external` (only from source
`billing`). `billing.receipt.external` (payload: `streamer` SubjectRef, `amount_cents`, `value_bits`,
`donor_name` — null when `anonymous` — `message`, `provider`, `provider_event_id`, `app_purpose`/`app_ref`,
`test`) is sent by Billing only once it is the money authority (`BILLING_AUTHORITY=billing` in
billing.env); before that Live's own PowerChat webhook announces those tips, so nothing is announced
twice. A `goal:<id>` in `app_purpose`/`app_ref` picks the goal (a Tips goal id); otherwise the creator's
only active goal.

## Overlays

`GET /overlay/<token>` is an OBS Browser Source page; `/overlay/<token>/events` is the SSE stream
(`hello` with config and active goals, then `alert` and `goal`, `config` on changes, `retract` when a
moderator hides an alert, `revoked`), and
`/overlay/<token>/state` a read-only JSON for other overlay clients (e.g. Live). Tokens are scoped
(`alerts`, `goals`), shown once, stored as SHA-256, revocable (open streams close at once) and never a
cookie. Every alert and goal change is one `overlay_deliveries` row with a monotonic `seq` (the SSE id):
the first write to an overlay marks it `delivered` (`tips.overlay.delivered`), a row no overlay showed
within `TIPS_OVERLAY_TTL_MS` becomes `failed` (`tips.overlay.failed`). A reconnect with `Last-Event-ID`
**replays** — it writes bytes to a socket and nothing else: no charge, no goal count, no event.

## Chat delivery

`server/delivery/` — an adapter is `{ name, deliver(job) → { ref } }` (throw to fail; `permanent` stops
retries). `chat` (`server/delivery/chat.js`) posts to OpenVibe.Chat's typed ingress at `TIPS_CHAT_URL`
with Tips' service token (audience `openvibe.chat`; OpenVibe.Chat `docs/chat-ingress.md`):

| Effect | Chat call | Body |
|---|---|---|
| `chat_line`, `paid_message` | `POST /internal/chat/messages` (`chat.message.send`) | `channel_user_id`, `username` (the public name), `message` (the line), `message_type: donation`, `source_platform: tips`, `mirror: true` (global chat too), `metadata { kind: donation, source, amount, message, username, interaction_id, paid_message, highlight_seconds, test }` |
| | then `POST /internal/chat/events` (`chat.event.publish`) | `target { kind: channel, id }`, `frame { type: alert, streamerId, kind: donation }` (the alert sound) |
| `tts` | `POST /internal/chat/messages` | a `tts` line (`message` = the filtered TTS text) with `tts { voice, identity_key: tips:<interaction>, key: tips-<interaction> }`: Chat saves it and reads it aloud |
| `media_request` | none | fails at once: the media queue is not Chat's |

Every body's `key` is the effect's delivery id (`<interaction>:<effect>`; the alert `<delivery id>:alert`):
Chat applies a key once and answers a repeat with the first result, so a retry after a 5xx or a lost answer
never posts twice. A 4xx (other than 401/408/425/429) fails the effect at once, everything else is retried
with backoff; a refused alert does not undo the line (`ref.alert: false`). Chat's rooms are Live's ids: the
adapter reads the creator's Live user id from the Network (`GET /internal/identity/resolve`, kept ten
minutes); a creator with no Live account fails at once. The body is rebuilt on each attempt from the
interaction's current public view, so a word-filter change between attempts makes Chat answer 409, which
fails the effect. A job carries the interaction's public view and `privacy`: "Anonymous" and no subject
for an anonymous supporter, `amount: null` and a line without the amount when it is hidden, no private
message. `test` records jobs in memory (development; simulations always use it). `none` (the production
default) creates no chat effects, and it is what production runs. To enable delivery: grant the `tips`
principal the three capabilities above, then set `TIPS_CHAT_ADAPTER=chat` (and `TIPS_CHAT_URL` when Chat
is not on `127.0.0.1:4400`).

## Pages (server-rendered, useful without JavaScript)

`/` · `/<handle>` (goals + tip form posting to checkout; `index,follow` only when the creator switched the
page on, otherwise 404 for everyone else and a `noindex` preview for the creator) · `/<handle>/goals` ·
`/<handle>/supporters` (when the creator shows it) · `/receipts`, `/receipts/:id` (payment and delivery
shown separately, with the privacy chosen), `/receipts/export`, `/receipts/erase` · `/moderate/<handle>`
(the creator and their moderators), `/moderate/invite/<secret>` · `/dashboard` (page settings, public pages, moderation,
goals, overlay links shown once, alert settings, simulation, totals, recent tips, overlay deliveries) ·
`/robots.txt`, `/sitemap.xml` (switched-on pages only) · `/release.json` · `/terms`, `/privacy`, `/dmca`.
Signed-in forms carry an HMAC anti-forgery token and a per-render nonce. Shared chrome: Network
`navbar.js`, `openvibe-shared` app icon, SSR footer and `<noscript>` navigation.

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). Tips never moves money (ADR-012): it holds
references to Billing transaction ids, never a balance. People sign in with Network SSO; services use
client-credentials tokens for audience `openvibe.tips`, one capability per route. Overlays use revocable
scoped tokens, hashed at rest, never creator cookies. Billing's events arrive signed
(`TIPS_EVENTS_SECRET`) through an inbox that dedupes them; `/internal/` and `/metrics` are never public.
Tips calls only its configured Network, Billing, Events and Chat hosts. Secrets (`OV_OAUTH_CLIENT_SECRET`,
`TIPS_FORM_SECRET`, `TIPS_EVENTS_SECRET`) live in `/etc/openvibe/tips.env` (0600).

[docs/threat-review.md](docs/threat-review.md) is the written threat review: overlays (tokenised URLs),
paid-message abuse, TTS, amount spoofing, replay and privacy, with each finding's status and the test
that shows it. The fixes it made:
- a Billing donation settles an interaction only when amount, creator and supporter match;
- a replayed `POST /overlay-tokens` answer carries no secret, and none is stored;
- open streams per overlay token (`TIPS_OVERLAY_MAX_STREAMS`) and unpaid checkouts per supporter
  (`TIPS_MAX_PENDING_CHECKOUTS`) are bounded;
- the creator's own name is refused as a supporter name;
- invisible and direction-override characters are dropped, and TTS text carries no markup.

The regressions are in `test/security.test.js`. It is an internal review; an independent one is still due
before launch.

### Per-actor limits

`/api/v1` also limits who calls it, once the credential is checked and before any work (the idempotency
store, Billing, chat delivery): `server/api/actor-limits.js`, openvibe-sdk/limits, roadmap WS-R task 4. A
service counts as its principal (`svc:live`), a person as `user:usr_…`, anyone else by address. Past a limit:
`429` problem+json `rate_limited` with `Retry-After`, one log line and `tips_rate_limited_total{limit,window}`.

| Routes | Per caller |
|---|---|
| Every read | `TIPS_LIMITS_MINUTE` / `TIPS_LIMITS_HOUR` (120 a minute, 3000 an hour) |
| `POST /checkout`, `/paid-messages`, `/tts-requests`, `/media-requests` (one budget) | a person 20 / 200; a service 60 / 1200 |
| `POST /interactions/external` | 60 / 1200 |
| Profile, goal and overlay config changes, token revoke | 30 / 300 |
| `POST /overlay-tokens` | 10 / 60 |
| Hide and restore | 60 / 600 |
| Moderators add and remove; `POST /simulate` | 10 / 100 |
| `POST /me/erase` | 3 / 10 |

Never limited: `/api/health`, `/api/ready`, `/release.json`, `/metrics`, the overlays (bounded by
`TIPS_OVERLAY_MAX_STREAMS`) and the signed Events deliveries at `/internal/events`. `test/actor-limits.test.js`.
With `VALKEY_URL` every process counts one caller together (`test/integration.test.js`).

## Acceptance (must be true before "done")

| Criterion | Evidence |
|---|---|
| a duplicate provider webhook yields one Billing transaction and one logical interaction | `test/settlement.test.js` (same event redelivered, same transaction under a new event id, foreign donation delivered three times) |
| overlay replay never charges again | `test/overlays.test.js` (three `Last-Event-ID` replays: transfers, contributions, goal total, payable, events unchanged) |
| the creator can use openvibe.tips with Live offline | pages, API, overlays and settlement need no Live call (`test/pages.test.js`, `test/overlays.test.js` run with no Live); chat delivery goes to OpenVibe.Chat and its failure never touches payment (`test/delivery.test.js`) — **not yet demonstrated on the real host** |
| creator totals reconcile exactly to Billing | `test/api.test.js` (totals = the stub Billing payable) |
| simulation never counted; token revocation immediate; goals from settled only; reversal keeps the delivery record | `test/overlays.test.js`, `test/api.test.js`, `test/settlement.test.js` |
| an EXTERNAL PowerChat tip Billing announced is celebrated once: chat line, overlay, goal; never Billing money | `test/external.test.js` (redelivery and republish, same key as `POST /interactions/external`, Tips goal ids, anonymous, test receipts, malformed payloads) |
| paid messages are filtered before they are shown or read; the creator and their moderators hide and show them without touching the money | `test/moderation.test.js` (mask, hold and release, invisible/full-width evasion, TTS text, invitation links, hide cancels queued chat/TTS and retracts the overlay live/replay/state, restore, pending payments, who may moderate, event payloads) |
| the suite passes on PostgreSQL behind PgBouncer in transaction mode; one settlement or reversal raced across two processes counts once; the unpaid-checkout limit holds under concurrency; leased work runs once; flushing Valkey changes no money answer (ADR-007 2026-09-24, ADR-035) | `npm run test:pg`; `test/integration.test.js` (two app instances on one database and one Valkey) |
| a supporter's privacy holds everywhere; the creator chooses what public pages show; export and erasure keep the books reconciled | `test/privacy.test.js` (anonymous / hidden amount / private message across API, overlays, chat jobs, pages and events; goal and supporters page settings; export; erasure scrubs rows, overlay payloads, stored answers and unsent events, emits `tips.interaction.erased`, totals still equal Billing) |

## What waits

- **Billing cutover** (Billing README runbook): until Live's money writes go through Billing, real tips
  still happen on Live; Tips can only record them from Billing events once Live sends donations as
  Billing transfers. For PowerChat checkout, Billing answers with a `checkout_ref` and no URL — Tips needs
  `TIPS_POWERCHAT_LINK_TEMPLATE` or Billing returning the link.
- **EXTERNAL PowerChat tips** arrive as `billing.receipt.external` once Billing is the authority. They need
  the `billing.receipt.*` subscription (`npm run subscribe`) and `TIPS_CHAT_ADAPTER=chat`; the chat
  adapter posts the chat line and plays the alert but does not advance **Live's own**
  `donation_goals` or send its `goal-update`/`goal-reached` frames (Tips' goals and overlay do advance).
  PowerChat follow/host/channel-points/subscription notices are not forwarded by anyone.
- **Chat**: `TIPS_CHAT_ADAPTER=chat` needs the Network to grant `tips` `chat.message.send` and
  `chat.event.publish` (audience `openvibe.chat`) and `identity.subject.resolve`. Paid media requests have
  no delivery route (Chat does not own the media queue): with `chat` they are recorded failed.
- **Refunds of paid media requests** that never played (Billing's `POST /transfers/:id/refund`) are not
  offered in Tips yet; a refund made elsewhere arrives as `billing.transaction.reversed` and is applied.
- Legal pages use the shared `ugc` profile, which does not describe payments.

## Deploy

Production deploys with `sudo ovhost deploy tips` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.tips`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-tips.service` on `127.0.0.1:4610`, the env file `/etc/openvibe/tips.env`. State lives in
`/var/lib/openvibe-tips`. The vhost [deploy/nginx/openvibe.tips.conf](deploy/nginx/openvibe.tips.conf)
waits for the launch: `openvibe.tips` serves the Sites placeholder.
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback tips --to <sha>`. Migrations are expand-only until a
`contract` migration, which waits out the 7-day N-1 window.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the following
exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability — ✔ `/api/health`, `/api/ready`
   (openvibe-shared/ready: the database required and reporting the store that answered; Valkey, the
   Network key, Billing and Events optional, so their loss degrades rather than fails), `/metrics` for direct loopback callers (golden signals by
   route template, pending effects and overlay deliveries, outbox backlog);
2. canonical identity/auth integration (Network subjects, scoped service principals) — ✔; the `tips`
   principal is provisioned on the host;
3. server-rendered public routes useful without JavaScript — ✔;
4. real persistence and end-to-end workflows — ✔ against stubs; not yet against the real Billing and
   Events (Billing is in shadow and has sent no events; production has no creator profile yet);
5. capability and event registration against OpenVibe.Contracts — ✔ v0.15.0, payload schemas in v0.30.2 and v0.32.0 (v0.79.0 pinned);
6. a migration/seed strategy ✔, a written threat review ✔ ([docs/threat-review.md](docs/threat-review.md),
   internal; an independent review is still due), and sitemap/robots ✔ (no feed);
7. acceptance tests proving the advertised functionality — ✔ (table above).

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and registers
maturity in the ecosystem registry atomically. A placeholder is never counted as an implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.127.0
- openvibe-sdk: v0.38.0
- openvibe-shared: v3.0.0
<!-- versions:end -->
