'use strict';

/**
 * Idempotency-Key for every mutating /api/v1 call (Billing's rule). The key is scoped to the
 * calling principal. The first 2xx response is stored with a hash of the request; a replay with the
 * same key and request returns it verbatim (Idempotent-Replayed: true) and does nothing; the same
 * key with another request is 422 idempotency.key_reused. Refusals are not stored.
 *
 * The key is claimed before the handler runs (a row with status 0), so the same key sent twice at once,
 * to one process or two, runs the handler once: the other request is answered 409
 * idempotency.in_progress with Retry-After, and a retry after the first finished gets the stored answer.
 * A 2xx answer is written into the claim before it is sent; any other outcome releases the claim. A
 * claim older than a minute (its process died mid-request) may be taken over.
 *
 * The scoped key also becomes the interaction's idempotency_key (UNIQUE), the second line of defence.
 */
const crypto = require('crypto');
const { http } = require('openvibe-contracts');
const { sql } = require('openvibe-sdk/db');

const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const CLAIM_MS = 60_000;
const PENDING = 0;   // api_idempotency.status of a claim whose answer is not in yet

function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}

const principalKey = (p) => (p.kind === 'service' ? p.sub : p.kind === 'user' ? p.subject : 'anonymous');

function idempotent(db, now, log = console) {
    const iso = (ms) => new Date(ms).toISOString();
    return async function idempotencyKey(req, res, next) {
        const key = req.get('Idempotency-Key');
        if (!key || !KEY_RE.test(key)) {
            return http.sendProblem(res, 400, 'idempotency.key_required', { detail: 'mutating calls need an Idempotency-Key header (8-200 of A-Z a-z 0-9 . _ : -)', ctx: req.ov });
        }
        const scoped = `${principalKey(req.principal)}:${key}`;
        const hash = crypto.createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${stable(req.body || {})}`).digest('hex');
        const path = `${req.baseUrl}${req.path}`;
        let claimed;
        let row = null;
        try {
            const at = now();
            claimed = await db.maybe(sql`INSERT INTO api_idempotency (key, request_hash, method, path, status, response, created_at)
                VALUES (${scoped}, ${hash}, ${req.method}, ${path}, ${PENDING}, '', ${iso(at)})
                ON CONFLICT (key) DO UPDATE SET request_hash = excluded.request_hash, method = excluded.method, path = excluded.path, created_at = excluded.created_at
                    WHERE api_idempotency.status = ${PENDING} AND api_idempotency.created_at < ${iso(at - CLAIM_MS)}
                RETURNING key`);
            if (!claimed) row = await db.maybe(sql`SELECT request_hash, status, response FROM api_idempotency WHERE key = ${scoped}`);
        } catch (e) { return next(e); }
        if (!claimed) {
            if (row && row.request_hash !== hash) return http.sendProblem(res, 422, 'idempotency.key_reused', { detail: 'this Idempotency-Key was used for a different request', ctx: req.ov });
            if (!row || row.status === PENDING) {
                res.setHeader('Retry-After', '1');
                return http.sendProblem(res, 409, 'idempotency.in_progress', { detail: 'a request with this Idempotency-Key is still being handled; retry shortly for its answer', ctx: req.ov });
            }
            res.setHeader('Idempotent-Replayed', 'true');
            // The stored text is the answer as first sent (jsonb would reorder its keys).
            return res.status(row.status).type('application/json').send(row.response);
        }
        req.idempotencyKey = `api:${scoped}`;
        let answered = false;
        const release = () => {
            if (answered) return;
            answered = true;
            db.exec(sql`DELETE FROM api_idempotency WHERE key = ${scoped} AND status = ${PENDING} AND request_hash = ${hash}`)
                .catch((e) => log.warn(`[Tips] Idempotency-Key claim not released: ${e.message}`));
        };
        res.on('finish', release);
        res.on('close', release);
        const json = res.json.bind(res);
        res.json = (body) => {
            if (answered || res.statusCode < 200 || res.statusCode >= 300) return json(body);
            answered = true;
            // A handler whose answer carries a secret (an overlay token) sets res.locals.storedBody: the
            // replay gets that instead, so no secret is kept in plain text here. An upsert: an erasure
            // during the request may have removed the claim.
            const stored = res.locals.storedBody !== undefined ? res.locals.storedBody : body;
            db.exec(sql`INSERT INTO api_idempotency (key, request_hash, method, path, status, response, created_at)
                VALUES (${scoped}, ${hash}, ${req.method}, ${path}, ${res.statusCode}, ${JSON.stringify(stored)}, ${iso(now())})
                ON CONFLICT (key) DO UPDATE SET status = excluded.status, response = excluded.response, created_at = excluded.created_at
                    WHERE api_idempotency.request_hash = excluded.request_hash`)
                .catch((e) => log.warn(`[Tips] stored answer for an Idempotency-Key not kept: ${e.message}`))
                .then(() => json(body));
            return res;
        };
        return next();
    };
}

/**
 * Stored answers are kept for a week: long enough for any client retry, and no longer, since they
 * carry messages and subjects (a supporter's erasure removes theirs at once).
 */
const RETAIN_MS = 7 * 24 * 3600 * 1000;
function pruneAnswers(db, now = Date.now(), retainMs = RETAIN_MS) {
    return db.exec(sql`DELETE FROM api_idempotency WHERE created_at < ${new Date(now - retainMs).toISOString()}`);
}

module.exports = { idempotent, stable, principalKey, pruneAnswers, RETAIN_MS };
