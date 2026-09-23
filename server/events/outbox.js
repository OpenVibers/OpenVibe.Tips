'use strict';

/**
 * Tips → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   tips.interaction.ready      settled: the interaction is active and its effects are queued
 *   tips.interaction.failed     an effect gave up after its retries (payment state untouched)
 *   tips.interaction.cancelled  undelivered effects cancelled (payment reversed/failed, or the creator)
 *   tips.goal.updated           a goal's settled total, target or status changed
 *   tips.overlay.delivered      an overlay delivery reached at least one overlay (first time only)
 *   tips.overlay.failed         no overlay received it within the delivery window
 *
 * enqueue() runs inside the SQLite transaction that makes the change, so an event exists if and
 * only if its change committed. Simulations (test) never produce events. The relay publishes with
 * Tips' service token (events.event.publish, audience openvibe.events) only when EVENTS_URL and
 * OV_OAUTH_CLIENT_SECRET are set; otherwise rows wait in event_outbox.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

const ACTOR = { type: 'service', id: 'tips' };

function createTipsOutbox({ db, config, fetchImpl, now, log = console }) {
    const enabled = !!(config.events.url && config.oauth.clientSecret);
    const clientOpts = { baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' }, retries: 0 };
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (EVENTS_URL / OV_OAUTH_CLIENT_SECRET unset)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source: 'tips' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[Tips] event publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    /** Inside the caller's transaction. */
    function emit(eventType, subject, payload, { visibility = 'internal', priority = 'important', traceparent } = {}) {
        return outbox.enqueue({ event_type: eventType, actor: ACTOR, subject, payload, visibility, priority }, { traceparent });
    }

    return {
        emit,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        kick() { if (enabled) outbox.kick(); },
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createTipsOutbox };
