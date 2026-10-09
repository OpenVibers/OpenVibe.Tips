'use strict';

/**
 * Billing → Tips: POST /internal/events, the endpoint of Tips' OpenVibe.Events subscriptions
 * (topic patterns `billing.transaction.*` and `billing.receipt.*`, created by scripts/subscribe.js).
 *
 *   billing.transaction.settled   a donation targeting a Tips interaction settles it; a donation Tips
 *                                 did not start is recorded once; a purchase that funds a Tips
 *                                 checkout triggers the transfer
 *   billing.transaction.reversed  flips the interaction's payment state; undelivered effects are
 *                                 cancelled, delivered ones stay on record
 *   billing.receipt.external      a tip on the creator's own PowerChat (EXTERNAL, no Billing money):
 *                                 recorded once by (provider, provider event id) and announced by Tips —
 *                                 chat line, overlay alert, goal. Billing sends it only once it is the
 *                                 money authority (while Live is, Live's webhook announces the tip)
 *
 * Exactly once, twice over: the openvibe-sdk inbox claims (consumer, event_id) in the same
 * transaction as the change, so a redelivered event does nothing; and the Billing transaction id is
 * UNIQUE on tip_interactions, so the same transaction arriving under another event id (a replay, a
 * republish) still yields one logical interaction. That transaction moves money state, so it is
 * SERIALIZABLE (domain MONEY): two deliveries racing in two processes settle once.
 *
 * The signature (X-OpenVibe-Signature, HMAC-SHA256 of the raw body with TIPS_EVENTS_SECRET) is
 * verified with openvibe-sdk's parseDelivery. Only events whose source is `billing` are applied.
 *
 * network.account.export_requested and network.account.deleted (ADR-033, subscribed at boot) go to
 * domain/account-data.js instead, outside the money inbox: openvibe-sdk/account-data keeps its own receipt
 * per export and deletion id (account_data_events) and throws when Network should be asked again, so a
 * failure is answered 500 and Events redelivers.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { parseDelivery, createPgInbox } = require('openvibe-sdk/events');

const { TOPICS: ACCOUNT_TOPICS } = require('openvibe-sdk/account-data');

const CONSUMER = 'tips-billing';
const TABLE = 'tips_event_inbox';   // migrations/0001_initial.sql (inboxSchema)

function consumerRouter({ domain, config, log = console, accountData = null, accountSend = null }) {
    const router = express.Router();
    // The inbox's transaction is the domain's MONEY one (serializable, with after-commit hooks).
    const inbox = createPgInbox({ tx: (fn) => domain.tx(fn, domain.MONEY), maybe: (...a) => domain.db.maybe(...a) }, { table: TABLE, now: domain.now });

    /** Apply one envelope (also used by tests and the replay tool). Returns { duplicate, outcome }. */
    async function apply(event) {
        if (ACCOUNT_TOPICS.includes(event.event_type)) {
            if (!accountData || !accountSend) throw new Error('account export and deletion are not configured');
            return { duplicate: false, outcome: await accountData.apply(event, { send: accountSend }) };
        }
        const r = await inbox.once(CONSUMER, event.event_id, async (t) => {
            if (event.source !== 'billing') return 'ignored:source';
            const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
            if (event.event_type === 'billing.transaction.settled') return domain.interactions.onBillingSettled(t, payload);
            if (event.event_type === 'billing.transaction.reversed') return domain.interactions.onBillingReversed(t, payload);
            if (event.event_type === 'billing.receipt.external') return domain.interactions.onBillingExternal(t, payload);
            return 'ignored:type';
        });
        return r.duplicate ? { duplicate: true, outcome: null } : { duplicate: false, outcome: r.result };
    }

    router.post('/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const secrets = config.events.webhookSecrets;
        if (!secrets.length) return http.sendProblem(res, 503, 'tips.webhook_disabled', { detail: 'TIPS_EVENTS_SECRET is not set', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        // Signature v2 only: HMAC over "<t>.<raw body>" with t within ±300 s; a v1-only (v2 stripped) or stale delivery is refused.
        for (const s of secrets) { delivery = parseDelivery(raw, req.headers, s, { requireV2: true }); if (delivery) break; }
        if (!delivery) return http.sendProblem(res, 401, 'tips.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx: req.ov });
        const event = delivery.event;
        if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
            return http.sendProblem(res, 400, 'tips.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx: req.ov });
        }
        let out;
        try {
            out = await apply(event);
        } catch (e) {
            // Not acknowledged: Events retries it, and the inbox claim rolled back with the change.
            log.error(`[Tips] event ${event.event_id} (${event.event_type}) failed:`, e.message);
            return http.sendProblem(res, 500, 'tips.event_failed', { detail: 'processing failed; it will be retried', ctx: req.ov });
        }
        res.status(200).json({ event_id: event.event_id, duplicate: out.duplicate, outcome: out.outcome });
    });

    return { router, apply };
}

module.exports = { consumerRouter, CONSUMER };
