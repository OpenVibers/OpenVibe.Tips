'use strict';

/**
 * The overlays' live side: open SSE streams, fan-out between processes, and the per-token stream cap.
 *
 * Streams are sockets of one process; what they must hear can happen in any process (a tip settled by
 * another process, a moderator's hide, a config change, a revocation). Each process subscribes, per
 * creator with an open stream here, to `overlay:<creator>` on openvibe-sdk/pubsub (Valkey, or in-process
 * without it) and acts on what arrives:
 *
 *   { t: 'new' }                          push the creator's new deliveries (read from the database)
 *   { t: 'retract', interaction_id, rows } tell alert streams to drop an alert a moderator hid
 *   { t: 'config', config }               a changed overlay config, to the streams using it
 *   { t: 'revoke', token_id }             close the token's streams at once
 *
 * Nothing authoritative travels here: a lost message costs a push that the next one (or a reconnect's
 * replay from the database) makes up.
 *
 * Stream slots (TIPS_OVERLAY_MAX_STREAMS per token) are counted across processes in a Valkey sorted set
 * per creator (member <token>|<stream>, score = expiry); a stream refreshes its slot on every heartbeat,
 * so a dead process's slots lapse after three missed heartbeats. `connected(creator)` counts the live
 * slots. Without Valkey, or when it fails, the slots are counted in this process.
 */
const crypto = require('crypto');
const { createPubSub } = require('openvibe-sdk/pubsub');

// Drop lapsed slots, count the token's, and take one when under the cap, atomically.
// KEYS[1] the creator's set; ARGV: now, '<token>|', max, expiry, member, ttl (ms).
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = 0
for _, m in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  if string.sub(m, 1, #ARGV[2]) == ARGV[2] then n = n + 1 end
end
if n >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return 1`;

function memorySlots(now) {
    const byCreator = new Map();   // creator → Map(member → expiry)
    const live = (creator) => {
        const m = byCreator.get(creator);
        if (!m) return new Map();
        for (const [k, exp] of m) if (exp <= now()) m.delete(k);
        if (!m.size) byCreator.delete(creator);
        return m;
    };
    return {
        async acquire(creator, tokenId, member, max, ttlMs) {
            const m = live(creator);
            if ([...m.keys()].filter((k) => k.startsWith(`${tokenId}|`)).length >= max) return false;
            if (!byCreator.has(creator)) byCreator.set(creator, m);
            m.set(member, now() + ttlMs);
            return true;
        },
        async refresh(creator, member, ttlMs) { const m = byCreator.get(creator); if (m && m.has(member)) m.set(member, now() + ttlMs); },
        async release(creator, member) { const m = byCreator.get(creator); if (m) { m.delete(member); if (!m.size) byCreator.delete(creator); } },
        async count(creator) { return live(creator).size; },
    };
}

function valkeySlots(valkey, now) {
    const c = valkey.client;
    if (typeof c.tipsOverlayAcquire !== 'function') c.defineCommand('tipsOverlayAcquire', { numberOfKeys: 1, lua: ACQUIRE });
    const key = (creator) => valkey.key('overlay', 'streams', creator);
    return {
        async acquire(creator, tokenId, member, max, ttlMs) {
            const t = now();
            return (await c.tipsOverlayAcquire(key(creator), String(t), `${tokenId}|`, String(max), String(t + ttlMs), member, String(ttlMs))) === 1;
        },
        async refresh(creator, member, ttlMs) { await c.multi().zadd(key(creator), 'XX', now() + ttlMs, member).pexpire(key(creator), ttlMs).exec(); },
        async release(creator, member) { await c.zrem(key(creator), member); },
        async count(creator) { return c.zcount(key(creator), now(), '+inf'); },
    };
}

/**
 * @param {object} o
 * @param {object|null} o.valkey     openvibe-sdk/valkey handle, or null (in-process)
 * @param {(client) => Promise<void>} o.pushNew   read and write a client's new deliveries
 * @param {number} o.heartbeatMs
 */
function createOverlayHub({ valkey = null, pushNew, heartbeatMs, now = () => Date.now(), log = console }) {
    const ps = createPubSub({ valkey, log });
    const local = memorySlots(now);
    const shared = valkey ? valkeySlots(valkey, now) : null;
    const ttlMs = heartbeatMs * 3;
    let warned = false;
    /** The shared slot store; on a Valkey error this call counts in the process instead. */
    const slots = async (op, ...args) => {
        if (shared) {
            try { return await shared[op](...args); } catch (e) {
                if (!warned) { warned = true; log.warn(`[Tips] overlay stream slots: Valkey failed (${e.message}); counting in this process`); }
            }
        }
        return local[op](...args);
    };
    const creators = new Map();   // creator → { clients: Set, off: Promise<() => Promise> }
    let nextClient = 1;

    function write(client, event, id, data) {
        if (client.closed) return false;
        try {
            client.res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            return true;
        } catch { return false; }
    }

    /** Run fn for a client after whatever it is already doing (its pushes never interleave). */
    function queue(client, fn) {
        client.chain = client.chain.then(() => (client.closed ? null : fn())).catch((e) => log.warn('[Tips] overlay push:', e.message));
        return client.chain;
    }
    /** New deliveries for this client: coalesced, so a burst of notifications reads once. */
    function schedulePush(client) {
        if (client.pushQueued) return;
        client.pushQueued = true;
        queue(client, () => { client.pushQueued = false; return pushNew(client); });
    }

    function onMessage(creator, msg) {
        const entry = creators.get(creator);
        if (!entry || !msg) return;
        for (const c of [...entry.clients]) {
            if (msg.t === 'new') schedulePush(c);
            else if (msg.t === 'retract' && c.scopes.includes('alerts')) {
                queue(c, () => { for (const r of msg.rows || []) write(c, 'retract', null, { interaction_id: msg.interaction_id, delivery_id: r.id, seq: r.seq }); });
            } else if (msg.t === 'config' && msg.config && c.configId === msg.config.id) {
                queue(c, () => { write(c, 'config', null, { config: msg.config }); });
            } else if (msg.t === 'revoke' && c.tokenId === msg.token_id) {
                write(c, 'revoked', null, { reason: 'this overlay token was revoked' });
                detach(c);
            }
        }
    }

    // Through Valkey every process hears it, this one included. If publishing fails, this process's own
    // streams still hear it (the others catch up from the database on their next push or reconnect).
    const publish = (creator, msg) => ps.publish(`overlay:${creator}`, msg).then(() => undefined, (e) => {
        log.warn('[Tips] overlay fan-out:', e.message);
        onMessage(creator, JSON.parse(JSON.stringify(msg)));
    });

    /** Subscribe for a creator's messages; a failure is retried while the creator has streams here. */
    function subscribe(creator, entry) {
        entry.off = ps.subscribe(`overlay:${creator}`, (msg) => onMessage(creator, msg)).catch((e) => {
            log.warn('[Tips] overlay subscribe:', e.message);
            const retry = setTimeout(() => { if (creators.get(creator) === entry) subscribe(creator, entry); }, 5000);
            if (retry.unref) retry.unref();
            return async () => {};
        });
    }

    /** A stream place for this token, or null past the cap (the route answers 429). */
    async function reserve(token, max) {
        const slot = { creator: token.creator_subject, member: `${token.id}|${crypto.randomBytes(8).toString('hex')}` };
        return (await slots('acquire', slot.creator, token.id, slot.member, max, ttlMs)) ? slot : null;
    }

    /**
     * Register a stream (its slot reserved) and run `start(client)` (hello, replay) before any push.
     * The subscription is in place before start reads, so nothing committed meanwhile is missed.
     */
    function attach(token, res, slot, { minAmount = 0, configId = null }, start) {
        const client = {
            id: nextClient++, creator: token.creator_subject, tokenId: token.id, scopes: token.scopes, configId,
            minAmount, res, lastSeq: 0, closed: false, slot, chain: Promise.resolve(), pushQueued: false,
        };
        let entry = creators.get(client.creator);
        if (!entry) {
            entry = { clients: new Set(), off: null };
            creators.set(client.creator, entry);
            subscribe(client.creator, entry);
        }
        entry.clients.add(client);
        res.on('close', () => detach(client));
        if (res.destroyed) { detach(client); return client; }   // gone before it was attached
        client.beat = setInterval(() => {
            if (!write(client, 'ping', null, { t: Date.now() })) { detach(client); return; }
            slots('refresh', slot.creator, slot.member, ttlMs).catch(() => {});
        }, heartbeatMs);
        if (client.beat.unref) client.beat.unref();
        queue(client, async () => { await entry.off; await start(client); });
        schedulePush(client);
        return client;
    }

    function detach(client) {
        if (client.closed) return;
        client.closed = true;
        clearInterval(client.beat);
        slots('release', client.slot.creator, client.slot.member).catch(() => {});
        const entry = creators.get(client.creator);
        if (entry) {
            entry.clients.delete(client);
            if (!entry.clients.size) {
                creators.delete(client.creator);
                entry.off.then((off) => off()).catch(() => {});
            }
        }
        try { client.res.end(); } catch { /* already gone */ }
    }

    return {
        write,
        attach,
        reserve,
        /** Give a reserved slot back (the stream never started). */
        release: (slot) => slots('release', slot.creator, slot.member).catch(() => {}),
        /** Tell every process's streams of this creator: new deliveries are in the database. */
        notify: (creator) => publish(creator, { t: 'new' }),
        retract: (creator, interactionId, rows) => publish(creator, { t: 'retract', interaction_id: interactionId, rows }),
        config: (creator, config) => publish(creator, { t: 'config', config }),
        revoke: (creator, tokenId) => publish(creator, { t: 'revoke', token_id: tokenId }),
        /** Open streams of this creator's overlays, in every process. */
        connected: (creator) => slots('count', creator),
        closeAll() { for (const entry of [...creators.values()]) for (const c of [...entry.clients]) detach(c); },
        async close() { this.closeAll(); await ps.close(); },
    };
}

module.exports = { createOverlayHub };
