'use strict';

/**
 * Tips → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   tips.interaction.ready      settled: the interaction is active and its effects are queued
 *   tips.interaction.failed     an effect gave up after its retries (payment state untouched)
 *   tips.interaction.cancelled  undelivered effects cancelled (payment reversed/failed, or the creator)
 *   tips.interaction.moderated  a creator (or a moderator) acted on an interaction
 *   tips.interaction.erased     an erasure redacted a supporter's interaction
 *   tips.goal.updated           a goal's settled total, target or status changed
 *   tips.overlay.delivered      an overlay delivery reached at least one overlay (first time only)
 *   tips.overlay.failed         no overlay received it within the delivery window
 *
 * emitIn(t, …) runs inside the transaction that makes the change (its handle `t`), so an event exists
 * if and only if its change committed. Simulations (test) never produce events. The relay publishes
 * with Tips' service token (events.event.publish, audience openvibe.events) only when EVENTS_URL and
 * OV_OAUTH_CLIENT_SECRET are set; otherwise rows wait in tips_event_outbox. Any number of processes
 * relay the one table: the SDK claims due rows with a lease (FOR UPDATE SKIP LOCKED).
 *
 * Every envelope Tips writes uses ACTOR: the service is the actor (a person's act rides in the payload
 * as actor_subject), visibility 'internal' and priority 'important' as before.
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

const TABLE = 'tips_event_outbox';   // migrations/0001_initial.sql (outboxSchema)
const ACTOR = { type: 'service', id: 'tips' };
/** The defaults every Tips envelope carries (the SDK's createServiceOutbox sets none). */
const ENVELOPE = { actor: ACTOR, visibility: 'internal', priority: 'important' };

/** Tips' wiring of the SDK's shared outbox (plan T1). */
function createTipsOutbox({ db, config, fetchImpl, now, log = console }) {
    return createServiceOutbox({
        db,
        source: 'tips',
        table: TABLE,
        eventsUrl: config.events.url,
        networkInternalUrl: config.network.internalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs,
        log,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(now ? { now } : {}),
    });
}

module.exports = { createTipsOutbox, TABLE, ACTOR, ENVELOPE };
