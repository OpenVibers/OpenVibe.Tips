'use strict';

/**
 * Creator tip profiles: one per creator subject. A profile is created the first time the creator
 * opens the dashboard (or a service creates it for them); the handle and display name are a
 * projection of the Network account, refreshed on every dashboard visit.
 *
 * page_enabled is the creator's switch for the public page at openvibe.tips/<handle>: while it is
 * off the page answers 404 to everyone else and nothing about it is indexable.
 *
 * page_settings (JSON, `page` in the API) is what the public pages show, each supporter's own
 * privacy choices applying on top (privacy.js):
 *   goal_amounts         goal amounts (off: a goal shows its percentage only)
 *   goal_supporters      the latest supporters of each goal
 *   supporters_page      openvibe.tips/<handle>/supporters: the top supporters
 *   supporters_amounts   each top supporter's total, and amounts in the recent list
 *   supporters_messages  recent public messages on the supporters page
 *
 * filter_words / filter_action / filter_links are the creator's word filter for paid messages
 * (filter.js; `filter` in the API): filterOf(subject) is what every public view applies.
 */
const { sql } = require('openvibe-sdk/db');
const { fail, iso, text } = require('../util');
const filterLib = require('./filter');

const HANDLE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
// Paths the site itself uses; no creator page can take them.
const RESERVED = new Set(['api', 'auth', 'overlay', 'internal', 'dashboard', 'receipts', 'assets', 'css', 'js', 'img', 'favicon.svg',
    'robots.txt', 'sitemap.xml', 'llms.txt', 'release.json', 'manifest.webmanifest', 'terms', 'privacy', 'dmca', 'tos', 'about', 'help', 'goals', 'tips', 'admin', 'www',
    'moderate', 'supporters', 'metrics']);
const VOICES = ['gary', 'brian', 'amy', 'emma', 'joey', 'justin', 'matthew', 'salli', 'kimberly', 'kendra', 'ivy', 'joanna'];

function normalizeHandle(v) {
    const h = String(v || '').trim().toLowerCase().replace(/^@/, '');
    return HANDLE_RE.test(h) && !RESERVED.has(h) ? h : null;
}

const PAGE_DEFAULTS = Object.freeze({ goal_amounts: true, goal_supporters: false, supporters_page: false, supporters_amounts: false, supporters_messages: false });

/** page_settings (jsonb) → every setting, defaults filled in. */
function pageSettings(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const out = {};
    for (const k of Object.keys(PAGE_DEFAULTS)) out[k] = typeof s[k] === 'boolean' ? s[k] : PAGE_DEFAULTS[k];
    return out;
}

/** The creator's filter settings for publicView() from a profile row (filter_* columns). */
const filterOfRow = (row) => ({
    words: Array.isArray(row.filter_words) ? row.filter_words : [],
    action: row.filter_action === 'hold' ? 'hold' : 'mask',
    links: row.filter_links !== false,
});

function parse(row) {
    if (!row) return null;
    return { ...row, page: pageSettings(row.page_settings), filter: filterOfRow(row) };
}

const HANDLE_TAKEN = 'creator_tip_profiles_handle_key';

function createProfiles(ctx) {
    const { db } = ctx;

    const bySubject = async (q, s) => parse(await q.maybe(sql`SELECT * FROM creator_tip_profiles WHERE creator_subject = ${String(s || '')}`));
    const byHandle = async (q, h) => { const n = normalizeHandle(h); return n ? parse(await q.maybe(sql`SELECT * FROM creator_tip_profiles WHERE handle = ${n}`)) : null; };
    /** usr_… or a handle (with or without @). */
    const resolve = async (q, ref) => (/^usr_/.test(String(ref || '')) ? await bySubject(q, String(ref)) : await byHandle(q, ref));

    /** A handle not held by another creator: the username, else username-<suffix of the subject>. */
    async function freeHandle(q, subject, username) {
        let h = normalizeHandle(username) || `creator-${subject.slice(-8).toLowerCase()}`;
        const holder = await q.maybe(sql`SELECT creator_subject FROM creator_tip_profiles WHERE handle = ${h}`);
        if (holder && holder.creator_subject !== subject) h = `${h.slice(0, 30)}-${subject.slice(-6).toLowerCase()}`;
        return h;
    }

    /**
     * Create or refresh the profile from the creator's own Network account (claims). Two first visits
     * at once create it once; a handle another creator took meanwhile is looked for again.
     */
    async function ensure(subject, claims = {}, attempt = 0) {
        try { return await ensureOnce(subject, claims); } catch (e) {
            if (e.code === '23505' && e.constraint === HANDLE_TAKEN && attempt < 2) return await ensure(subject, claims, attempt + 1);
            throw e;
        }
    }
    async function ensureOnce(subject, { username, displayName, avatarUrl } = {}) {
        const at = iso(ctx.now());
        const existing = await bySubject(db, subject);
        const name = String(displayName || username || 'Creator').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Creator';
        if (!existing) {
            const row = await db.maybe(sql`INSERT INTO creator_tip_profiles (creator_subject, handle, display_name, avatar_url, created_at, updated_at)
                VALUES (${subject}, ${await freeHandle(db, subject, username)}, ${name}, ${safeUrl(avatarUrl)}, ${at}, ${at})
                ON CONFLICT (creator_subject) DO NOTHING RETURNING *`);
            return row ? parse(row) : await bySubject(db, subject);
        }
        const handle = normalizeHandle(username) && normalizeHandle(username) !== existing.handle ? await freeHandle(db, subject, username) : existing.handle;
        if (handle !== existing.handle || name !== existing.display_name || (safeUrl(avatarUrl) || null) !== (existing.avatar_url || null)) {
            return parse(await db.one(sql`UPDATE creator_tip_profiles SET handle = ${handle}, display_name = ${name}, avatar_url = ${safeUrl(avatarUrl)}, updated_at = ${at}
                WHERE creator_subject = ${subject} RETURNING *`));
        }
        return existing;
    }

    const LIMITS = {
        min_amount: [1, 1_000_000], paid_message_min: [1, 1_000_000], tts_min_amount: [1, 1_000_000],
        media_request_min: [1, 1_000_000], media_max_seconds: [10, 3 * 3600],
    };
    const BOOLS = ['page_enabled', 'accepting', 'tts_enabled', 'media_requests_enabled'];
    const on = (v) => v === true || v === 'on' || v === '1' || v === 1;

    /**
     * A settings change, on the locked row (two changes at once apply one after the other, neither lost).
     * With expectedRevision it applies only to that revision (else 409).
     */
    function update(subject, patch = {}, { expectedRevision } = {}) {
        return ctx.tx(async (t) => {
            const p = parse(await t.maybe(sql`SELECT * FROM creator_tip_profiles WHERE creator_subject = ${String(subject || '')} FOR UPDATE`));
            if (!p) fail(404, 'tips.profile_not_found', 'no tip profile for this creator');
            if (expectedRevision != null && Number(expectedRevision) !== p.revision) fail(409, 'tips.revision_conflict', `the profile is at revision ${p.revision}`);
            return await change(t, p, patch);
        });
    }

    async function change(t, p, patch) {
        const subject = p.creator_subject;
        const set = {};
        for (const k of BOOLS) if (patch[k] !== undefined) set[k] = on(patch[k]);
        for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
            if (patch[k] === undefined || patch[k] === '') continue;
            const n = Number(patch[k]);
            if (!Number.isInteger(n) || n < lo || n > hi) fail(422, 'tips.invalid_input', `${k} must be a whole number between ${lo} and ${hi}`);
            set[k] = n;
        }
        if (patch.tts_max_chars !== undefined && patch.tts_max_chars !== '') {
            const n = Number(patch.tts_max_chars);
            if (!Number.isInteger(n) || n < 20 || n > ctx.config.limits.ttsHardCap) fail(422, 'tips.invalid_input', `tts_max_chars must be between 20 and ${ctx.config.limits.ttsHardCap}`);
            set.tts_max_chars = n;
        }
        if (patch.tts_voice !== undefined) {
            if (!VOICES.includes(String(patch.tts_voice))) fail(422, 'tips.invalid_input', `tts_voice must be one of ${VOICES.join(', ')}`);
            set.tts_voice = String(patch.tts_voice);
        }
        if (patch.headline !== undefined) set.headline = text(patch.headline, 'headline', 280);
        if (patch.page !== undefined) {
            if (!patch.page || typeof patch.page !== 'object' || Array.isArray(patch.page)) fail(422, 'tips.invalid_input', `page must be an object of ${Object.keys(PAGE_DEFAULTS).join(', ')}`);
            const unknown = Object.keys(patch.page).filter((k) => !(k in PAGE_DEFAULTS));
            if (unknown.length) fail(422, 'tips.invalid_input', `page has no setting ${unknown[0]}`);
            const next = { ...p.page };
            for (const k of Object.keys(PAGE_DEFAULTS)) if (patch.page[k] !== undefined) next[k] = on(patch.page[k]);
            set.page_settings = sql.json(next);
        }
        if (patch.filter !== undefined) {
            const f = patch.filter;
            if (!f || typeof f !== 'object' || Array.isArray(f)) fail(422, 'tips.invalid_input', 'filter must be an object { words, action, links }');
            const unknown = Object.keys(f).filter((k) => !['words', 'action', 'links'].includes(k));
            if (unknown.length) fail(422, 'tips.invalid_input', `filter has no setting ${unknown[0]}`);
            if (f.words !== undefined) set.filter_words = sql.json(filterLib.normalizeWords(f.words));
            if (f.action !== undefined) {
                if (!filterLib.ACTIONS.includes(f.action)) fail(422, 'tips.invalid_input', `filter.action must be one of ${filterLib.ACTIONS.join(', ')}`);
                set.filter_action = f.action;
            }
            if (f.links !== undefined) set.filter_links = on(f.links);
        }
        if (patch.display_name !== undefined) {
            const n = text(patch.display_name, 'display_name', 80);
            if (!n) fail(422, 'tips.invalid_input', 'display_name cannot be empty');
            set.display_name = n.replace(/[<>]/g, '');
        }
        if (!Object.keys(set).length) return p;
        return parse(await t.one(sql`UPDATE creator_tip_profiles SET ${sql.set({ ...set, updated_at: iso(ctx.now()) })}, revision = revision + 1
            WHERE creator_subject = ${subject} RETURNING *`));
    }

    /** Public shape; `owner` adds the settings only the creator sees. */
    function present(p, { owner = false } = {}) {
        if (!p) return null;
        const out = {
            creator: { type: 'user', id: p.creator_subject }, handle: p.handle, display_name: p.display_name, avatar_url: p.avatar_url || null,
            headline: p.headline || null, page_enabled: p.page_enabled, accepting: p.accepting, url: `${ctx.config.baseUrl}/${p.handle}`,
            minimums: { tip: p.min_amount, paid_message: p.paid_message_min, tts: p.tts_enabled ? p.tts_min_amount : null, media_request: p.media_requests_enabled ? p.media_request_min : null },
            tts: { enabled: p.tts_enabled, max_chars: p.tts_max_chars, voice: p.tts_voice },
            media_requests: { enabled: p.media_requests_enabled, max_seconds: p.media_max_seconds },
            page: p.page,
            supporters_url: p.page.supporters_page ? `${ctx.config.baseUrl}/${p.handle}/supporters` : null,
            currency: 'vibes-bits',
        };
        if (owner) Object.assign(out, { filter: p.filter, revision: p.revision, created_at: p.created_at, updated_at: p.updated_at });
        return out;
    }

    /** The creator's filter settings for publicView() (null when they have no profile). */
    async function filterOf(q, subject) {
        const row = await q.maybe(sql`SELECT filter_words, filter_action, filter_links FROM creator_tip_profiles WHERE creator_subject = ${subject}`);
        return row ? filterOfRow(row) : null;
    }
    /** Several creators' profiles in one query: Map(subject → profile | null). */
    async function bySubjects(q, subjects) {
        const list = [...new Set(subjects)];
        const out = new Map(list.map((s) => [s, null]));
        if (!list.length) return out;
        for (const row of await q.many(sql`SELECT * FROM creator_tip_profiles WHERE creator_subject = ANY(${list})`)) out.set(row.creator_subject, parse(row));
        return out;
    }

    /** Several creators' filters in one query: Map(subject → settings | null). */
    async function filtersOf(q, subjects) {
        const list = [...new Set(subjects)];
        const out = new Map(list.map((s) => [s, null]));
        if (!list.length) return out;
        for (const row of await q.many(sql`SELECT creator_subject, filter_words, filter_action, filter_links FROM creator_tip_profiles WHERE creator_subject = ANY(${list})`)) {
            out.set(row.creator_subject, filterOfRow(row));
        }
        return out;
    }

    return { bySubject, bySubjects, byHandle, resolve, ensure, update, present, normalizeHandle, filterOf, filtersOf };
}

function safeUrl(u) {
    if (!u) return null;
    try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString().slice(0, 500) : null; } catch { return null; }
}

module.exports = { createProfiles, normalizeHandle, RESERVED, VOICES, safeUrl, PAGE_DEFAULTS, pageSettings };
