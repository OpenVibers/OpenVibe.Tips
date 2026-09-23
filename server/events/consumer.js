'use strict';

/**
 * Billing → Tips: POST /internal/events, the endpoint of Tips' OpenVibe.Events subscription
 * (topic pattern `billing.transaction.*`, created by scripts/subscribe.js).
 *
 *   billing.transaction.settled   a donation targeting a Tips interaction settles it; a donation Tips
 *                                 did not start is recorded once; a purchase that funds a Tips
 *                                 checkout triggers the transfer
 *   billing.transaction.reversed  flips the interaction's payment state; undelivered effects are
 *                                 cancelled, delivered ones stay on record
 *
 * Exactly once, twice over: the openvibe-sdk inbox claims (consumer, event_id) in the same SQLite
 * transaction as the change, so a redelivered event does nothing; and the Billing transaction id is
 * UNIQUE on tip_interactions, so the same transaction arriving under another event id (a replay, a
 * republish) still yields one logical interaction.
 *
 * The signature (X-OpenVibe-Signature, HMAC-SHA256 of the raw body with TIPS_EVENTS_SECRET) is
 * verified with openvibe-sdk's parseDelivery. Only events whose source is `billing` are applied.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');

const CONSUMER = 'tips-billing';

function consumerRouter({ domain, config, log = console }) {
    const router = express.Router();
    const inbox = createInbox(domain.db, { now: domain.now });
    inbox.ensureSchema();

    /** Apply one envelope (also used by tests and the replay tool). Returns { duplicate, outcome }. */
    function apply(event) {
        return domain.tx(() => {
            const r = inbox.once(CONSUMER, event.event_id, () => {
                if (event.source !== 'billing') return 'ignored:source';
                const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
                if (event.event_type === 'billing.transaction.settled') return domain.interactions.onBillingSettled(payload);
                if (event.event_type === 'billing.transaction.reversed') return domain.interactions.onBillingReversed(payload);
                return 'ignored:type';
            });
            return r.duplicate ? { duplicate: true, outcome: null } : { duplicate: false, outcome: r.result };
        });
    }

    router.post('/events', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        const secrets = config.events.webhookSecrets;
        if (!secrets.length) return http.sendProblem(res, 503, 'tips.webhook_disabled', { detail: 'TIPS_EVENTS_SECRET is not set', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        for (const s of secrets) { delivery = parseDelivery(raw, req.headers, s); if (delivery) break; }
        if (!delivery) return http.sendProblem(res, 401, 'tips.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx: req.ov });
        const event = delivery.event;
        if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
            return http.sendProblem(res, 400, 'tips.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx: req.ov });
        }
        let out;
        try {
            out = apply(event);
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
