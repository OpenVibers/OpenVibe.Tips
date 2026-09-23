'use strict';

/** Small shared pieces: ids, time, the error type, input checks. */
const crypto = require('crypto');
const { ids, validate } = require('openvibe-contracts');

class TipsError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.extra = extra;
    }
}

function fail(status, code, detail, extra) { throw new TipsError(status, code, detail, extra); }

const prefixedId = (prefix, ms = Date.now()) => `${prefix}_${ids.ulid(ms)}`;
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const json = (v, d) => { if (v == null || v === '') return d; try { return JSON.parse(v); } catch { return d; } };

function positiveInt(v, field, max) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) fail(422, 'tips.invalid_amount', `${field} must be a positive whole number of bits`);
    if (max && n > max) fail(422, 'tips.invalid_amount', `${field} must be at most ${max}`);
    return n;
}

// Zero-width, bidi embedding/override/isolate marks, word joiner, BOM, soft hyphen: they hide words
// from the creator's filter and turn text around on stream (docs/threat-review.md).
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Optional trimmed text: null when empty, refused when longer than max. Invisible characters are dropped. */
function text(v, field, max) {
    if (v == null) return null;
    const s = String(v).replace(INVISIBLE, '').replace(/\r\n?/g, '\n').trim();
    if (!s) return null;
    if (s.length > max) fail(422, 'tips.text_too_long', `${field} must be at most ${max} characters`);
    return s;
}

/** A user SubjectRef or bare usr_ id → the subject id. */
function userSubject(v, field = 'subject') {
    const ref = typeof v === 'string' ? { type: 'user', id: v } : v;
    if (!ref || !validate('identity.subject-ref@1', ref).valid || ref.type !== 'user' || !ids.isSubjectId('user', ref.id)) {
        fail(422, 'tips.invalid_subject', `${field} must be a user SubjectRef ({ type: 'user', id: 'usr_…' })`);
    }
    return ref.id;
}

function entityRef(v, field = 'target') {
    if (v == null) return null;
    if (!validate('common.entity-ref@1', v).valid) fail(422, 'tips.invalid_input', `${field} must be an EntityRef ({ service, type, id })`);
    return { service: v.service, type: v.type, id: String(v.id) };
}

/** The display name a supporter chose, kept short, without markup characters. */
function displayName(v) {
    if (v == null) return null;
    const s = String(v).replace(INVISIBLE, '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80);
    return s || null;
}

module.exports = { TipsError, fail, prefixedId, iso, sha256, json, positiveInt, text, userSubject, entityRef, displayName, INVISIBLE };
