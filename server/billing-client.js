'use strict';

/**
 * OpenVibe.Billing client (the only place money moves, ADR-012): a thin wrapper over
 * openvibe-sdk/commerce, the client Tips shares with VIP. Tips holds one client-credentials token
 * for audience openvibe.billing with:
 *
 *   billing.intent.create    POST /api/v1/intents     checkout: the supporter buys the credit they give
 *   billing.transfer.create  POST /api/v1/transfers   a tip from the supporter's credit to the creator
 *                            POST /api/v1/transfers/:id/refund  a paid media request that never played
 *
 * Every POST carries an Idempotency-Key derived from the interaction id, so a retry after a lost
 * response (or a crash) returns Billing's original transaction instead of moving money twice.
 *
 * Errors: a Billing problem+json becomes a BillingCallError (commerce's CommerceError) with
 * .status/.code (4xx: Billing refused, e.g. billing.insufficient_funds, billing.frozen); a network
 * failure has no status and is retryable.
 */
const { createCommerceClient, CommerceError: BillingCallError } = require('openvibe-sdk/commerce');

// One token for every call, as before: every logical capability maps to the same scope, so
// commerce creates (or takes) a single token client.
const SCOPE = 'billing.intent.create billing.transfer.create';
const CAPS = { intent: SCOPE, transfer: SCOPE, rates: SCOPE };

function createBillingClient(config, { fetchImpl = globalThis.fetch, tokenClient } = {}) {
    const commerce = createCommerceClient(config, { caps: CAPS, fetchImpl, tokenClients: tokenClient ? { [SCOPE]: tokenClient } : null });
    return {
        /** { intent, checkout_url } — kind purchase: the supporter buys `bits` of credit. */
        createIntent: async ({ provider, subject, bits, successUrl, cancelUrl, key, traceparent }) =>
            await commerce.createIntent({ provider, kind: 'purchase', subject, bits, successUrl, cancelUrl, key, traceparent }),
        /** { transaction } — credit of `from` → payable of `to`, tagged with the interaction. */
        createTransfer: async ({ from, to, amount, kind, target, message, key, traceparent }) =>
            await commerce.createTransfer({ from, to, amount, kind, target, message, key, traceparent }),
        refundTransfer: async ({ txnId, amount, reason, key }) => await commerce.refundTransfer({ txnId, amount, reason, key }),
        rates: async () => await commerce.rates(),
    };
}

module.exports = { createBillingClient, BillingCallError };
