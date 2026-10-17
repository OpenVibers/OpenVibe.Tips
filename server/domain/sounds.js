'use strict';

/**
 * Paid sounds: a creator's short sounds that supporters pay to play on stream (the owner's "paid soundboard … triggers").
 *
 *   list(q, creator)            the creator's sounds, oldest first: { id, name, url, mime, bytes }
 *   get(q, id)                  one sound's row with its file (serving)
 *   add(creator, { name, data }) a new sound (the creator's profile row is locked: 12 at most)
 *   remove(creator, id)         delete one of the creator's sounds
 *
 * A file is an MP3, OGG or WAV of at most 512 KB, recognised by its first bytes (never by a name or a header the
 * browser sent), served from /sounds/<id> with its own type, no sniffing and a sandboxing CSP. A sound's file never
 * changes, so the URL is cached for good.
 */
const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');
const { fail, prefixedId, iso, text } = require('../util');

const MAX_SOUNDS = 12;
const MAX_BYTES = 512 * 1024;
const ID_RE = /^tsnd_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The audio type of a file from its first bytes, or null. */
function sniff(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf.slice(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';   // an MPEG audio frame sync
    if (buf.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
    return null;
}

const EXT = { 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

function createSounds(ctx) {
    const { db } = ctx;
    const url = (id) => `/sounds/${id}`;
    const present = (r) => ({ id: r.id, name: r.name, url: url(r.id), mime: r.mime, bytes: Number(r.bytes) });

    async function list(q, creator) {
        const rows = await q.many(sql`SELECT id, name, mime, bytes FROM creator_sounds WHERE creator_subject = ${String(creator || '')} ORDER BY created_at, id`);
        return rows.map(present);
    }

    async function get(q, id) {
        if (!ID_RE.test(String(id || ''))) return null;
        return q.maybe(sql`SELECT * FROM creator_sounds WHERE id = ${String(id)}`);
    }

    /** One of this creator's sounds (for a request), or null. */
    async function ofCreator(q, creator, id) {
        if (!ID_RE.test(String(id || ''))) return null;
        const r = await q.maybe(sql`SELECT id, name, mime, bytes FROM creator_sounds WHERE id = ${String(id)} AND creator_subject = ${String(creator || '')}`);
        return r ? present(r) : null;
    }

    async function add(creator, { name, data }) {
        const label = text(name, 'name', 40);
        if (!label) fail(422, 'tips.invalid_input', 'a sound needs a name');
        if (!Buffer.isBuffer(data) || !data.length) fail(422, 'tips.invalid_sound', 'no file was sent');
        if (data.length > MAX_BYTES) fail(413, 'tips.sound_too_large', `a sound can be at most ${MAX_BYTES / 1024} KB`);
        const mime = sniff(data);
        if (!mime) fail(415, 'tips.invalid_sound', 'a sound must be an MP3, OGG or WAV file');
        return ctx.tx(async (t) => {
            if (!(await ctx.lockCreator(t, creator))) fail(404, 'tips.profile_not_found', 'set up your tip page first');
            const n = Number((await t.one(sql`SELECT count(*)::int AS n FROM creator_sounds WHERE creator_subject = ${creator}`)).n);
            if (n >= MAX_SOUNDS) fail(409, 'tips.too_many_sounds', `you can keep ${MAX_SOUNDS} sounds; delete one first`);
            const row = await t.one(sql`INSERT INTO creator_sounds (id, creator_subject, name, mime, bytes, sha256, data, created_at)
                VALUES (${prefixedId('tsnd', ctx.now())}, ${creator}, ${label.replace(/[<>]/g, '')}, ${mime}, ${data.length}, ${crypto.createHash('sha256').update(data).digest('hex')}, ${data}, ${iso(ctx.now())})
                RETURNING id, name, mime, bytes`);
            return present(row);
        });
    }

    async function remove(creator, id) {
        if (!ID_RE.test(String(id || ''))) fail(404, 'tips.sound_not_found', 'no such sound');
        const n = await db.exec(sql`DELETE FROM creator_sounds WHERE id = ${String(id)} AND creator_subject = ${String(creator || '')}`);
        if (!n) fail(404, 'tips.sound_not_found', 'no such sound');
        return true;
    }

    return { list, get, ofCreator, add, remove, sniff, EXT, MAX_SOUNDS, MAX_BYTES, ID_RE };
}

module.exports = { createSounds, sniff, MAX_SOUNDS, MAX_BYTES };
