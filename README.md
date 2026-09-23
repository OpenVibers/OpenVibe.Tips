# OpenVibe.Tips

> Creator support: tips, goals, paid messages, TTS and media requests, overlays.

**Status:** alpha — runtime built and tested against stubs (roadmap Wave 9). Deployed internally, not
launched: running on the host since 2026-09-23 on `127.0.0.1:4610` only, with an empty database and no
public route. OpenVibe.Live remains where tips happen until the Billing cutover (see *What waits*).  
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
  `paid_media_requests`, `overlay_configs`, `overlay_deliveries`, `interaction_effects`, `migration_maps`
  (its own SQLite, `server/db.js`) — interaction state and **references** to Billing transaction ids,
  never a mutable cash balance
- revocable scoped overlay tokens (`overlay_tokens`, hashed at rest; never creator cookies)

## Does not own

- monetary accounting, prices, balances, refunds, payouts (OpenVibe.Billing)
- chat rooms, TTS synthesis and queues (OpenVibe.Chat; Live's chat server until Chat's cutover)
- media bytes and the media queue (OpenVibe.Media / Live)
- identity (OpenVibe.Network)

## Depends on

- **OpenVibe.Billing** — `POST /api/v1/intents` (checkout), `POST /api/v1/transfers` (a tip from credit),
  `billing.transaction.settled|reversed` events, and `billing.receipt.external` (a tip on a creator's own
  PowerChat, once Billing receives the PowerChat webhook)
- **OpenVibe.Events** — Billing's events in (signed webhook + openvibe-sdk inbox), Tips' events out
  (openvibe-sdk transactional outbox)
- **OpenVibe.Network** — SSO for people, service tokens, JWKS, identity resolve (importer)
- **OpenVibe.Live** — chat delivery through `/internal/tips/deliveries` (deployed in Live since `f11f809`; [docs/live-patch.diff](docs/live-patch.diff) is the original patch) until OpenVibe.Chat exposes paid messages; overlay consumer
- **OpenVibe.Shared** v1.3.0 (app icon, SSR footer, noscript nav, release manifest, legal pages) and
  the Network's `navbar.js`

## Run it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env            # OV_OAUTH_CLIENT_SECRET, TIPS_FORM_SECRET, TIPS_EVENTS_SECRET, …
npm run dev                     # http://localhost:4610
npm test                        # every test/*.test.js: stub Network/Billing/Events/Live, temp DBs, random ports
npm run subscribe               # create the billing.transaction.* and billing.receipt.* subscriptions in OpenVibe.Events
node scripts/import-live.js --live-db <live snapshot> --billing-db <billing snapshot> [--dry-run] [--json]
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

A delivery failure (Live down, chat refused) is retried with backoff and finally recorded on the
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

**Exactly one logical interaction:** the inbox claims `(consumer, event_id)` in the same SQLite
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

## API

`/api/v1`, problem+json errors, `Idempotency-Key` on every POST/PATCH. Services present a Network
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
| `GET /moderation?creator=&state=held\|hidden\|visible\|all` | `tips.interaction.moderate` (proposed) | the creator and their moderators |
| `POST /interactions/:id/hide`, `POST /interactions/:id/restore` `{reason?}` | `tips.interaction.moderate` (proposed) | the creator and their moderators |
| `GET /moderation/log?creator=` | `tips.interaction.moderate` (proposed) | owner |
| `GET\|POST /moderators`, `POST /moderators/:subject/remove` | `tips.profile.update` | owner |
| `POST /goals`, `PATCH /goals/:id`, `POST /goals/:id/close` | `tips.goal.create` / `.update` / `.close` | owner |
| `GET\|POST /overlay-tokens`, `POST /overlay-tokens/:id/revoke` | `tips.overlay.token.create` / `.revoke` | owner |
| `GET /overlay-configs[/:id]`, `POST /overlay-configs`, `PATCH /overlay-configs/:id` | `tips.overlay.config.get` / `.update` | owner |
| `POST /simulate` | `tips.simulation.run` | owner |
| `POST /internal/events` | Events webhook signature (`TIPS_EVENTS_SECRET`), loopback only | — |

`tips.interaction.moderate` is proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/) and
not in openvibe-contracts yet (grants are matched by string, so a Network grant of it works today).
The capabilities and the service manifest were released in openvibe-contracts v0.15.0 (3-segment ids:
the charter's `tips.simulate` is `tips.simulation.run`; `tips.interaction.record` is new, for EXTERNAL
tips); the drafts stay in [docs/capabilities-proposal/](docs/capabilities-proposal/) and
[docs/service-manifest-proposal.json](docs/service-manifest-proposal.json). Grants are matched with
contracts' `capabilities.grants()` (exact id or a `.*` family). Tips pins openvibe-contracts v0.30.2,
which also carries the payload schemas of the six `tips.*` events below; `test/contracts.test.js`
validates every envelope and payload Tips produces against them.

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

Produced through the openvibe-sdk outbox (table `event_outbox`, source `tips`, same transaction as the
change; relayed when `EVENTS_URL` and the client secret are set): `tips.interaction.ready`,
`tips.interaction.failed`, `tips.interaction.cancelled`, `tips.goal.updated`, `tips.overlay.delivered`,
`tips.overlay.failed`, and two whose schemas are proposed in [docs/events-proposal/](docs/events-proposal/)
(not yet in openvibe-contracts): `tips.interaction.erased` (a supporter's erasure; `{ interaction_id,
creator, erased_at, redacts }`) and `tips.interaction.moderated` (`{ interaction_id, creator, action:
filtered|held|hidden|restored, by: filter|creator|moderator|service, moderation_state, cancelled_effects }`).
Simulations and Billing test money produce none. An anonymous supporter is never named in an event.
Consumed:
`billing.transaction.settled`, `billing.transaction.reversed`, `billing.receipt.external` (only from source
`billing`). `billing.receipt.external` (payload: `streamer` SubjectRef, `amount_cents`, `value_bits`,
`donor_name` — null when `anonymous` — `message`, `provider`, `provider_event_id`, `app_purpose`/`app_ref`,
`test`) is sent by Billing only once it is the money authority (`BILLING_AUTHORITY=billing` in
billing.env); before that Live's own PowerChat webhook announces those tips, so nothing is announced
twice. A `goal:<id>` in `app_purpose`/`app_ref` picks the goal: a Tips goal id, or a Live `donation_goals`
id mapped by the Live import; otherwise Live's rule (the only active goal).

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
retries). `live-chat` posts to Live's `/internal/tips/deliveries` with Tips' service token (audience
`openvibe.live`, `live.tips_delivery.write`), `Idempotency-Key = <interaction>:<effect>`; Live does what
`POST /api/funds/donate` does after the money moved (channel + global broadcast, a `donation` chat
message, the alert sound), TTS through `synthesizeAndBroadcastTTS`, media requests into its queue at no
charge. A job carries the interaction's public view and `privacy`: "Anonymous" and no subject for an
anonymous supporter, `interaction.amount: null` and a line without the amount when it is hidden, no
private message. (Live's route turns a null amount into a `donation` event of 0 Vibes, which its chat
renders as "donated 0 Vibes"; it should render an amount-less line when `privacy.hide_amount` is set.)
The route came from [docs/live-patch.diff](docs/live-patch.diff) and is deployed in Live since
`f11f809` (its idempotency record is in memory only); nothing calls it yet. `test`
records jobs in memory (development; simulations always use it). `none` (the production default) creates
no chat effects, and it is what production runs. When OpenVibe.Chat publishes a paid-message capability, a `chat` adapter replaces
`live-chat`.

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

## Import and reconciliation

`scripts/import-live.js` reads a **copy** of Live's database (read-only) after Billing's own import, and
a copy of Billing's database for the links and totals:

- `transactions` donations → interactions (`settlement imported`), linked to Billing by its importer key
  `import:live:txn:<live id>`; non-completed rows excluded with the reason; rows before
  `stats_vibes_reset_at` flagged test (as Billing flags them); unmapped creators **held**, released by a
  later run; Live refunds applied to the donation they undo
- PowerChat donations recorded only in `chat_messages` → EXTERNAL interactions; the celebration line of a
  site-routed `pcdon` tip is matched to its transaction and not counted twice
- `donation_goals` → goals, Live's `current_amount` carried over as `opening_amount`
- reconciliation: per creator, Tips' `settled_via_billing` must equal Billing's (donations to them minus
  refunds from them, non-test); mismatches are listed and the exit code is 1. Every source row ends up
  imported, excluded with a reason, or held (`migration_maps`).

## Acceptance (must be true before "done")

| Criterion | Evidence |
|---|---|
| a duplicate provider webhook yields one Billing transaction and one logical interaction | `test/settlement.test.js` (same event redelivered, same transaction under a new event id, foreign donation delivered three times) |
| overlay replay never charges again | `test/overlays.test.js` (three `Last-Event-ID` replays: transfers, contributions, goal total, payable, events unchanged) |
| the creator can use openvibe.tips with Live offline | pages, API, overlays and settlement need no Live call (`test/pages.test.js`, `test/overlays.test.js` run with no Live); only the `live-chat` adapter talks to Live and its failure never touches payment (`test/delivery.test.js`) — **not yet demonstrated on the real host** |
| creator totals reconcile exactly to Billing | `test/import.test.js` (fixtures in Live's schema and Billing's importer keys; a Billing donation Tips never saw is reported, then reconciles once its event arrives); `test/api.test.js` (totals = the stub Billing payable) |
| simulation never counted; token revocation immediate; goals from settled only; reversal keeps the delivery record | `test/overlays.test.js`, `test/api.test.js`, `test/settlement.test.js` |
| an EXTERNAL PowerChat tip Billing announced is celebrated once: Live chat line, overlay, goal; never Billing money | `test/external.test.js` (redelivery and republish, same key as `POST /interactions/external`, Tips and Live goal ids, anonymous, test receipts, malformed payloads) |
| paid messages are filtered before they are shown or read; the creator and their moderators hide and show them without touching the money | `test/moderation.test.js` (mask, hold and release, invisible/full-width evasion, TTS text, invitation links, hide cancels queued chat/TTS and retracts the overlay live/replay/state, restore, pending payments, who may moderate, event payloads) |
| a supporter's privacy holds everywhere; the creator chooses what public pages show; export and erasure keep the books reconciled | `test/privacy.test.js` (anonymous / hidden amount / private message across API, overlays, chat jobs, pages and events; goal and supporters page settings; export; erasure scrubs rows, overlay payloads, stored answers and unsent events, emits `tips.interaction.erased`, totals still equal Billing) |

## What waits

- **Billing cutover** (Billing README runbook): until Live's money writes go through Billing, real tips
  still happen on Live; Tips can only record them from Billing events once Live sends donations as
  Billing transfers. For PowerChat checkout, Billing answers with a `checkout_ref` and no URL — Tips needs
  `TIPS_POWERCHAT_LINK_TEMPLATE` or Billing returning the link.
- **EXTERNAL PowerChat tips** arrive as `billing.receipt.external` once Billing is the authority. They need
  the `billing.receipt.*` subscription (`npm run subscribe`) and `TIPS_CHAT_ADAPTER=live-chat`; Live's
  `/internal/tips/deliveries` posts the chat line and plays the alert but does not advance **Live's own**
  `donation_goals` or send its `goal-update`/`goal-reached` frames (Tips' goals and overlay do advance).
  PowerChat follow/host/channel-points/subscription notices are not forwarded by anyone.
- **Chat**: `live-chat` needs `TIPS_CHAT_ADAPTER=live-chat` after the cutover (Live's route is deployed); OpenVibe.Chat has no public
  paid-message/TTS capability yet. The Live patch's media-request path (yt-dlp/oEmbed) is not covered by
  its test.
- **Refunds of paid media requests** that never played (Billing's `POST /transfers/:id/refund`) are not
  offered in Tips yet; a refund made elsewhere arrives as `billing.transaction.reversed` and is applied.
- Legal pages use the shared `ugc` profile, which does not describe payments.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the following
exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability — ✔ `/api/health`, `/api/ready`
   (openvibe-shared/ready: the database required; Network key, Billing and Events optional, so
   their loss degrades rather than fails), `/metrics` for direct loopback callers (golden signals by
   route template, pending effects and overlay deliveries, outbox backlog);
2. canonical identity/auth integration (Network subjects, scoped service principals) — ✔; the `tips`
   principal is provisioned on the host;
3. server-rendered public routes useful without JavaScript — ✔;
4. real persistence and end-to-end workflows — ✔ against stubs; not yet against the real Billing and
   Events (Billing is in shadow and has sent no events; the production database is empty; the Live
   import has not been run);
5. capability and event registration against OpenVibe.Contracts — ✔ v0.15.0, payload schemas in v0.30.2 (pinned);
6. a migration/seed strategy ✔, a security/threat review (not done beyond the tests' refusals), and
   sitemap/robots ✔ (no feed);
7. acceptance tests proving the advertised functionality — ✔ (table above).

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and registers
maturity in the ecosystem registry atomically. A placeholder is never counted as an implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
