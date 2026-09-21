# OpenVibe.Tips

> Creator support: tips, goals, paid messages, TTS and media requests, overlays.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.tips`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §11.2.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

A first-class creator product that orchestrates Billing, Chat, Live and Media. Settlement is Billing's; Tips owns the interaction, goals, overlays and creator configuration, and always distinguishes *payment settled* from *interaction delivered*.

## Owns

- `tip_interactions`, `creator_tip_profiles`, `tip_goals`, `tip_goal_contributions`, `paid_messages`, `paid_media_requests`, `overlay_configs`, `overlay_deliveries`, `interaction_effects`, `migration_maps`
- revocable scoped overlay tokens (never creator cookies)

## Does not own

- monetary accounting (Billing)
- chat/TTS queues (Chat)
- media bytes (Media)

## Planned surfaces

- `apps/web` SSR creator page, tip page, goals, history/receipts, TTS/paid-message config, overlays, simulation/test mode
- `apps/api`, `packages/domain`, `packages/overlays`, `workers/` post-settlement orchestration

## Data (authority tables / families)

- see above

## Capabilities and events

- `tips.profile.get|update`, `tips.checkout.create`, `tips.interaction.get|list`, `tips.goal.*`, `tips.superchat.create`, `tips.tts.request`, `tips.media_request.create`, `tips.overlay.token.create|revoke`, `tips.overlay.config.*`, `tips.simulate`

Events: ``tips.interaction.ready|failed|cancelled``, ``tips.goal.updated``, ``tips.overlay.delivered|failed``

## Depends on

- OpenVibe.Billing
- OpenVibe.Chat
- OpenVibe.Media
- OpenVibe.Events
- OpenVibe.Live (overlay consumer only)

## Acceptance (must be true before "done")

- a duplicate provider webhook yields one Billing transaction and one logical interaction
- overlay replay never charges again
- the creator can use openvibe.tips with Live offline
- creator totals reconcile exactly to Billing

## Bootstrap / extraction source

Live's Vibes/PayPal tipping, cashout, alert/overlay and paid-interaction behaviour, migrated only after Billing reconciliation.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
