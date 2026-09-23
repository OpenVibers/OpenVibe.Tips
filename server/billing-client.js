'use strict';

/**
 * OpenVibe.Billing client (the only place money moves, ADR-012). Tips holds a client-credentials
 * token for audience openvibe.billing with:
 *
 *   billing.intent.create    POST /api/v1/intents     checkout: the supporter buys the credit they give
 *   billing.transfer.create  POST /api/v1/transfers   a tip from the supporter's credit to the creator
 *                            POST /api/v1/transfers/:id/refund  a paid media request that never played
 *
 * Every POST carries an Idempotency-Key derived from the interaction id, so a retry after a lost
 * response (or a crash) returns Billing's original transaction instead of moving money twice.
 *
 * Errors: a Billing problem+json becomes a BillingCallError with .status/.code (4xx: Billing
 * refused, e.g. billing.insufficient_funds, billing.frozen); a network failure has no status and is
 * retryable.
 */
const { serviceAuth } = require('openvibe-contracts');

class BillingCallError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'BillingCallError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
    get retryable() { return this.status == null || this.status >= 500 || this.status === 429 || this.status === 401 || this.code === 'billing.frozen'; }
}

function createBillingClient(config, { fetchImpl = globalThis.fetch, tokenClient } = {}) {
    const base = config.billing.url;
    let tokens = tokenClient || null;
    const tokenClientFor = () => {
        if (!tokens) {
            tokens = serviceAuth.createTokenClient({
                tokenUrl: `${config.network.internalUrl}/oauth/token`,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: config.billing.audience,
                scope: 'billing.intent.create billing.transfer.create',
                fetchImpl,
            });
        }
        return tokens;
    };

    async function call(method, path, { body, key, traceparent, retried = false } = {}) {
        let auth;
        try { auth = await tokenClientFor().authHeaders(); } catch (e) { throw new BillingCallError(`token: ${e.message}`); }
        const headers = { Accept: 'application/json', ...auth };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (key) headers['Idempotency-Key'] = key;
        if (traceparent) headers.traceparent = traceparent;
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
        } catch (e) {
            throw new BillingCallError(`Billing unreachable: ${e.message}`);
        }
        if (res.status === 401 && !retried) { tokenClientFor().invalidate(); return call(method, path, { body, key, traceparent, retried: true }); }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (data && (data.code || data.error)) || `http_${res.status}`;
            throw new BillingCallError(`Billing ${res.status} ${code}: ${(data && data.detail) || ''}`.trim(), { status: res.status, code, body: data });
        }
        return data;
    }

    return {
        /** { intent, checkout_url } — kind purchase: the supporter buys `bits` of credit. */
        createIntent: ({ provider, subject, bits, successUrl, cancelUrl, key, traceparent }) => call('POST', '/api/v1/intents', {
            body: { provider, kind: 'purchase', subject: { type: 'user', id: subject }, bits, success_url: successUrl, cancel_url: cancelUrl },
            key, traceparent,
        }),
        /** { transaction } — credit of `from` → payable of `to`, tagged with the interaction. */
        createTransfer: ({ from, to, amount, kind, target, message, key, traceparent }) => call('POST', '/api/v1/transfers', {
            body: { from: { type: 'user', id: from }, to: { type: 'user', id: to }, amount, kind, target, message: message || undefined },
            key, traceparent,
        }),
        refundTransfer: ({ txnId, amount, reason, key }) => call('POST', `/api/v1/transfers/${encodeURIComponent(txnId)}/refund`, { body: { amount, reason }, key }),
        rates: () => call('GET', '/api/v1/rates'),
    };
}

module.exports = { createBillingClient, BillingCallError };
