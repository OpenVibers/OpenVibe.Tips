# OpenVibe.Tips threat review

**Date:** 2026-09-23. **Code reviewed:** `main` at the privacy and moderation commits (`2e79f74`, `c428a28`)
and the fixes that came with this review. **Author:** the OpenVibers team, with an AI coding agent.
This is a written internal review, not an independent audit. The roadmap's gate still asks for an
outside review before launch.

**Method:** we read the code paths end to end (`server/`, `public/js/overlay.js`,
`deploy/nginx/openvibe.tips.conf`), and Live's `/internal/tips/deliveries` where Tips depends on it.
Every claim below is backed by a test in `test/` or names the line that enforces it. Nothing was run
against production. Production runs Tips on loopback only, with an empty database, so none of these
issues was ever reachable from the internet.

## Scope and trust boundaries

| Party | Holds | Can reach Tips through |
|---|---|---|
| Anyone | nothing | public pages, `GET /api/v1` public reads, `/overlay/<token>` (only with a token) |
| Signed-in supporter | a Network user JWT (`ov_token` cookie on the pages, Bearer on the API) | tip form and API for their own tips, receipts, export, erase |
| Creator | the same, for their own profile | dashboard, goals, overlay tokens, filter, moderators, moderation |
| Moderator | a Network user JWT plus a `tip_moderators` row | `/moderate/<handle>`, hide/restore API for that creator only |
| OBS / an overlay client | an overlay token in the URL | `/overlay/<token>`, `/events` (SSE), `/state` |
| First-party service | a Network service token with `tips.*` capabilities | `/api/v1` routes, one capability each |
| OpenVibe.Billing (via Events) | the webhook signing secret | `POST /internal/events` on loopback |
| OpenVibe.Live | Tips' service token (`live.tips_delivery.write`) | Tips calls Live; Live never calls Tips |

**What we protect:**

- Tips' records must stay consistent with Billing's books. Tips never moves money.
- What reaches a creator's stream: overlays, chat lines and text-to-speech.
- Overlay tokens.
- Supporters' identities and choices.

## Findings

Status: **fixed** in this review, **holds** (checked and already enforced), **residual** (accepted and
documented), **elsewhere** (the fix belongs to another repository).

| # | Area | Threat | Status | Evidence |
|---|---|---|---|---|
| 1 | Amount spoofing | A Billing donation that names a pending Tips interaction settled it whatever its amount, sender or recipient. A 1-bit transfer from any service holding `billing.transfer.create` could "pay" a 10,000-bit paid message. | **fixed** | `onBillingSettled` settles only on an exact match of amount, creator and supporter; anything else is recorded as its own donation, so totals still reconcile. `test/security.test.js` |
| 2 | Overlays | The overlay token's secret was stored in plain text in `api_idempotency`, because the `POST /overlay-tokens` answer was kept for replays. That undid hashing at rest. | **fixed** | The stored answer has `secret: null`; a replay returns the token without its secret. `test/security.test.js` |
| 3 | Overlays | A leaked overlay link could open unlimited SSE streams, exhausting sockets and memory. | **fixed** | At most `TIPS_OVERLAY_MAX_STREAMS` (10) streams per token; more get a 429. `test/security.test.js` |
| 4 | Paid-message abuse | Unpaid checkouts were unbounded: each creates a row and a Billing intent. | **fixed** | At most `TIPS_MAX_PENDING_CHECKOUTS` (20) unpaid checkouts per supporter per day (429). `test/security.test.js` |
| 5 | Paid-message abuse | A supporter could tip under the creator's own name or handle (impersonation on stream). | **fixed** | Refused with 422 `tips.name_taken`, after NFKC folding and invisible-character removal. `test/security.test.js` |
| 6 | Paid-message abuse | Zero-width and direction-override characters were kept. They can hide a word from a filter or turn a line around on stream. | **fixed** | Dropped from names and texts at input (`util.js` `INVISIBLE`) and again at display (`filter.js clean`). `test/security.test.js`, `test/moderation.test.js` |
| 7 | TTS | TTS text could carry markup that a speech engine might read as SSML. | **fixed** | `<` and `>` are removed from TTS text, next to the existing removal of control characters and links. Live's engine takes plain text today, so this is defence in depth. `test/security.test.js` |
| 8 | Paid-message abuse, TTS | No way to keep a word off stream, and no way to take a paid message back. | **fixed** | Creator word filter (mask or hold) and hide/restore by the creator and their moderators, with the money untouched. `test/moderation.test.js` |
| 9 | Privacy | Supporters could not be anonymous, hide the amount or keep a message private, and could not export or erase their data. | **fixed** | Privacy controls, export and erasure. `test/privacy.test.js` |
| 10 | Privacy | Stored API answers, which carry messages and subjects, were kept forever. | **fixed** | Pruned after 7 days, and a supporter's erasure removes theirs at once. `api/idempotency.js pruneAnswers` |
| 11 | Overlays | Moderator invitation links, like overlay links, carry a secret in the path. | **holds** | Shown once, hashed, single use, expire after 7 days; `no-store`, `no-referrer`; nginx does not log `/moderate/invite/`. `test/moderation.test.js` |
| 12 | Replay | Webhook, API, form, overlay and event replays. | **holds** | See [Replay](#replay). `test/settlement.test.js`, `test/overlays.test.js`, `test/api.test.js`, `test/pages.test.js` |
| 13 | Privacy | A hidden amount still moves a public goal bar by that amount. | **residual** | Stated on the tip form. The goal update of such a tip names nobody. |
| 14 | Privacy | Internal events carry the amount, and the supporter's subject when the tip is not anonymous. | **residual** | The events are `internal` visibility. Goals and reconciliation need the amount. Erasure redacts them in Events. |
| 15 | Privacy, chat | Live's delivery route turns a hidden amount (`null`) into a donation event of 0 Vibes, and Live's chat renders it as "donated 0 Vibes". Live also remembers delivery ids in memory only. | **elsewhere** (Live) | The job carries `privacy.hide_amount`. Live should render a line with no amount. |
| 16 | Overlays | Overlay tokens never expire. | **residual** | The creator can revoke a token, and revocation closes open streams at once. Every token records when it was last used. |
| 17 | Rate limits | Tips has no rate limiting of its own. | **residual** | The nginx reference config limits `/api/`, `/auth/` and the form posts. Money limits paid actions, and fixes 3 and 4 bound the rest. |
| 18 | Paid-message abuse | Supporter names are still free text: only an exact copy of the creator's name is refused. Donor names that Billing relays from PowerChat are not checked. | **residual** | The word filter and moderation cover names. |

## Overlays (tokenised URLs)

- **Token strength and storage.** A token is `tovl_` followed by 32 random bytes (256 bits). Tips stores
  only its SHA-256 and shows the secret once. It is never a cookie: OBS holds it in the URL and nothing
  else. A creator can have at most 25 active tokens. Each token carries scopes (`alerts`, `goals`) and
  optionally a config (`domain/overlays.js`).
- **Leak paths.**
  - Referer: overlay responses send `Referrer-Policy: no-referrer`, and the page adds `<meta name="referrer">`. The creator's sound and image URLs therefore never see the token.
  - Logs: nginx has `access_log off` for `/overlay/`. Tips' metrics use route templates and skip the SSE route. Tips never logs a request path.
  - Caches and search engines: overlay responses are `no-store` and `X-Robots-Tag: noindex`, and robots.txt disallows `/overlay/`.
  - Stored API answers: fixed (#2).
  - What remains: the URL sits in OBS scene files and on screen when the creator shares their screen. The dashboard warns about this. The fix is revocation, which is immediate.
- **Revocation** marks the row and closes every open stream of that token in the same call. After that,
  `/events` and `/state` answer 404 (`test/overlays.test.js`).
- **What a token reads.** Only public views: an alert payload is `publicView()`, the same shape the
  public sees. That means privacy choices, the word filter and moderation all apply. `/state` lists the
  last 20 alerts that are not hidden, plus active goals. Nothing else about the creator is readable, and
  `/state` has no CORS header, so other sites' scripts cannot read it.
- **Rendering.** `overlay.js` builds every node with `textContent`. Image and sound URLs are https URLs
  that only the creator sets. The page keeps the site CSP: `default-src 'self'`, `img-src`/`media-src`
  https, and `frame-ancestors 'self'`.
- **Floods.** Fixed (#3). Tips holds no per-connection state beyond the socket and a heartbeat timer.
- **Moderation reaches overlays.** Hiding an alert sends `retract` to connected overlays, which drop it
  from the queue or clear it from the screen and stop its voice. Replays and `/state` skip it from then on
  (`test/moderation.test.js`).

## Paid-message abuse

- **Bounds.**
  - Messages: 300 characters.
  - TTS: the creator's limit, at most 1,200 characters.
  - Media requests: https links on an allowlist of YouTube hosts only, at most 500 characters.
  - The creator sets minimum amounts per kind. Money limits the volume, and fix #4 bounds the unpaid rest.
- **Content control, all before anything is shown or read.**
  - The creator's word filter (`filter.js`) matches whole words and phrases in any letter case. It applies
    after NFKC folding (full-width letters) and after removing invisible characters.
  - `mask` stars the words out; `hold` holds the message for review.
  - Links show as `[link]` by default.
  - Moderators hide a paid message later: queued chat, TTS and media deliveries are cancelled, and the
    overlay alert is retracted. The effects worker re-reads each effect before delivering it, so a hide
    during a batch is honoured.
- **Injection.**
  - Pages escape everything with `esc()`, and JSON-LD escapes `<`.
  - The overlay uses `textContent`.
  - Chat lines are plain text that Tips builds. Live renders them with its own escaping, which is Live's
    responsibility.
- **Impersonation and Unicode tricks:** fixed (#5 and #6). Long runs of combining marks are cut at display.
- **Media requests** cannot be private and go through moderation like paid messages. The URL is shown
  as-is because the video plays on stream anyway.

## TTS

- Tips never calls a speech provider. It hands text to Live's `synthesizeAndBroadcastTTS`, and to
  OpenVibe.Chat when an adapter exists.
- The text passes through `cleanTts`, which removes control and invisible characters, turns links into
  "link" and strips markup (#7). The creator's filter then drops blocked words from it rather than
  starring them. Voices come from an allowlist.
- The overlay's optional browser voice (`speak_message`) reads the same filtered public text.
- A held message is never read until it is approved. A hide cancels a TTS that is still queued, and
  `retract` stops an overlay voice that is already speaking.
- A TTS failure never touches the payment: the effect retries or fails on its own
  (`test/delivery.test.js`).

## Amount spoofing

- **Tips never sets a price or moves money.** Amounts are integer bits, 1 to 10,000,000, validated by
  `positiveInt`.
- **Credit tips.** Billing transfers exactly `interaction.amount` from the supporter's credit, and refuses
  when funds are short.
- **Checkout tips.** The Billing intent is for exactly that amount. The purchase only funds the supporter,
  and the same transfer then gives the money.
- **Keyed transfers.** Transfers use the key `tips:transfer:<id>` and Tips reads the settled answer from
  its own call, so a client can never make Tips credit more than Billing moved.
- **Donations that name an interaction** must match it exactly (#1).
- **EXTERNAL tips.** Their amounts come from Billing's signed `billing.receipt.external` or from a service
  holding `tips.interaction.record`. They stay out of Billing totals.
- **Goals** count contributions at settlement only, never tests. A reversal lowers them by what Billing
  took back.
- **Simulations** are flagged `test` everywhere and never counted (`test/overlays.test.js`).

## Replay

- **Billing webhook.**
  - HMAC signature v2 over `<t>.<raw body>`, with a ±300 s window. v1-only deliveries are refused.
  - The signing secrets rotate as a list, and `source` must be `billing`.
  - `/internal` refuses anything forwarded by nginx.
  - The openvibe-sdk inbox claims `(consumer, event_id)` in the same transaction as the change.
    `billing_txn_id` is UNIQUE, so the same transaction under a new event id is still one interaction
    (`test/settlement.test.js`).
- **API.** An `Idempotency-Key` is required on every write, scoped to the caller and hashed with the
  request. A replay returns the stored answer, without secrets (#2). A reused key with a different body
  gets 422 (`test/api.test.js`).
- **Forms.** An HMAC anti-forgery token (subject and day), an Origin check, `SameSite=Lax` cookies and a
  per-render nonce that makes a double submit one tip (`test/pages.test.js`).
- **Overlay replay** with `Last-Event-ID` writes bytes to a socket and nothing else: no charge, no goal
  count, no event (`test/overlays.test.js`).
- **Moderation actions** are idempotent: hiding twice publishes once. Invitation links work once.

## Privacy

- **Supporter choices** (`privacy.js`), stored per interaction:
  - `anonymous`: nobody but the supporter sees their name or subject. That includes the creator,
    moderators, services and events.
  - `hide_amount`: no amount on overlays, chat lines or public pages, and off the leaderboard.
  - `private_message`: the message goes to the creator only.
- **One public shape.** `publicView()` is the only thing that leaves Tips for the public
  (`test/privacy.test.js`).
- **Creator choices.** What the public goal and supporters pages show. The supporters page is off by
  default. The leaderboard counts only supporters who left both their name and their amount public, so a
  rank never reveals a hidden amount.
- **Export and erasure.** `GET /me/export` returns everything Tips holds about the supporter's tips.
  `POST /me/erase` removes:
  - the subject, name and messages;
  - TTS text and media links;
  - checkout references;
  - stored answers;
  - overlay payloads;
  - unsent events.

  It keeps the money record, so Billing and the creators' totals still reconcile. It emits
  `tips.interaction.erased` with `redacts`, and Events then turns Tips' earlier events about that
  interaction into tombstones. Billing keeps its own payment records under its own policy, and copies
  that other products already made (a Live chat line) stay theirs to delete.
- **Retention.**
  - Stored API answers: 7 days.
  - Sent outbox rows: pruned after 7 days (openvibe-sdk).
  - Overlay deliveries: kept, holding public views only.
  - Moderation log: kept for the creator's accountability; it names the moderator.
- **Moderators** see what was written, but never private messages, hidden amounts or payments.
  `tips.interaction.moderated` carries no supporter, message, note or moderator.
- **Pages.** Receipts, the dashboard, the moderation pages and invitation pages are `noindex` and
  disallowed in robots.txt.

## Contract additions this depends on

| Addition | Why | Where it is drafted |
|---|---|---|
| Event `tips.interaction.moderated` v1 | moderation outcomes | `docs/events-proposal/tips.interaction.moderated.v1.json` |
| Event `tips.interaction.erased` v1 | a supporter's erasure, which carries `redacts` | `docs/events-proposal/tips.interaction.erased.v1.json` |
| Capability `tips.interaction.moderate` | services that moderate for a creator | `docs/capabilities-proposal/tips.interaction.moderate.json` |

OpenVibe.Events accepts both event types today, because it checks the `tips.` prefix and not a catalog.
Consumers cannot validate their payloads against openvibe-contracts until the schemas are added. The
tests validate them against the drafts.

## Follow-ups

1. **Live:** render a tip whose amount is hidden (`privacy.hide_amount`, `interaction.amount: null`)
   without an amount, and persist the delivery idempotency key (#15).
2. **Contracts:** add the three items above, then register them in `manifests/services/tips.json`.
3. **Before launch:** get an independent review of this document and the code. Consider optional overlay
   token expiry (#16).
