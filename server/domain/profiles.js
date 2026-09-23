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
 */
const { fail, iso, text, json } = require('../util');

const HANDLE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
// Paths the site itself uses; no creator page can take them.
const RESERVED = new Set(['api', 'auth', 'overlay', 'internal', 'dashboard', 'receipts', 'assets', 'css', 'js', 'img', 'favicon.svg',
    'robots.txt', 'sitemap.xml', 'release.json', 'manifest.webmanifest', 'terms', 'privacy', 'dmca', 'tos', 'about', 'help', 'goals', 'tips', 'admin', 'www']);
const VOICES = ['gary', 'brian', 'amy', 'emma', 'joey', 'justin', 'matthew', 'salli', 'kimberly', 'kendra', 'ivy', 'joanna'];

function normalizeHandle(v) {
    const h = String(v || '').trim().toLowerCase().replace(/^@/, '');
    return HANDLE_RE.test(h) && !RESERVED.has(h) ? h : null;
}

const PAGE_DEFAULTS = Object.freeze({ goal_amounts: true, goal_supporters: false, supporters_page: false, supporters_amounts: false, supporters_messages: false });

function pageSettings(raw) {
    const stored = json(raw, {});
    const out = {};
    for (const k of Object.keys(PAGE_DEFAULTS)) out[k] = typeof stored[k] === 'boolean' ? stored[k] : PAGE_DEFAULTS[k];
    return out;
}

function parse(row) {
    if (!row) return null;
    const b = (k) => !!row[k];
    return { ...row, page_enabled: b('page_enabled'), accepting: b('accepting'), tts_enabled: b('tts_enabled'), media_requests_enabled: b('media_requests_enabled'), page: pageSettings(row.page_settings) };
}

function createProfiles(ctx) {
    const { db } = ctx;

    const bySubject = (s) => parse(db.prepare('SELECT * FROM creator_tip_profiles WHERE creator_subject = ?').get(s));
    const byHandle = (h) => { const n = normalizeHandle(h); return n ? parse(db.prepare('SELECT * FROM creator_tip_profiles WHERE handle = ?').get(n)) : null; };
    /** usr_… or a handle (with or without @). */
    const resolve = (ref) => (/^usr_/.test(String(ref || '')) ? bySubject(String(ref)) : byHandle(ref));

    /** A handle not held by another creator: the username, else username-<suffix of the subject>. */
    function freeHandle(subject, username) {
        let h = normalizeHandle(username) || `creator-${subject.slice(-8).toLowerCase()}`;
        const holder = db.prepare('SELECT creator_subject FROM creator_tip_profiles WHERE handle = ?').get(h);
        if (holder && holder.creator_subject !== subject) h = `${h.slice(0, 30)}-${subject.slice(-6).toLowerCase()}`;
        return h;
    }

    /** Create or refresh the profile from the creator's own Network account (claims). */
    function ensure(subject, { username, displayName, avatarUrl } = {}) {
        const at = iso(ctx.now());
        const existing = bySubject(subject);
        const name = String(displayName || username || 'Creator').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Creator';
        if (!existing) {
            db.prepare(`INSERT INTO creator_tip_profiles (creator_subject, handle, display_name, avatar_url, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(subject, freeHandle(subject, username), name, safeUrl(avatarUrl), at, at);
            return bySubject(subject);
        }
        const handle = normalizeHandle(username) && normalizeHandle(username) !== existing.handle ? freeHandle(subject, username) : existing.handle;
        if (handle !== existing.handle || name !== existing.display_name || (safeUrl(avatarUrl) || null) !== (existing.avatar_url || null)) {
            db.prepare('UPDATE creator_tip_profiles SET handle = ?, display_name = ?, avatar_url = ?, updated_at = ? WHERE creator_subject = ?')
                .run(handle, name, safeUrl(avatarUrl), at, subject);
        }
        return bySubject(subject);
    }

    const LIMITS = {
        min_amount: [1, 1_000_000], paid_message_min: [1, 1_000_000], tts_min_amount: [1, 1_000_000],
        media_request_min: [1, 1_000_000], media_max_seconds: [10, 3 * 3600],
    };
    const BOOLS = ['page_enabled', 'accepting', 'tts_enabled', 'media_requests_enabled'];

    function update(subject, patch = {}, { expectedRevision } = {}) {
        const p = bySubject(subject);
        if (!p) fail(404, 'tips.profile_not_found', 'no tip profile for this creator');
        if (expectedRevision != null && Number(expectedRevision) !== p.revision) fail(409, 'tips.revision_conflict', `the profile is at revision ${p.revision}`);
        const set = {};
        for (const k of BOOLS) if (patch[k] !== undefined) set[k] = patch[k] === true || patch[k] === 'on' || patch[k] === '1' || patch[k] === 1 ? 1 : 0;
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
            for (const k of Object.keys(PAGE_DEFAULTS)) if (patch.page[k] !== undefined) next[k] = patch.page[k] === true || patch.page[k] === 'on' || patch.page[k] === '1' || patch.page[k] === 1;
            set.page_settings = JSON.stringify(next);
        }
        if (patch.display_name !== undefined) {
            const n = text(patch.display_name, 'display_name', 80);
            if (!n) fail(422, 'tips.invalid_input', 'display_name cannot be empty');
            set.display_name = n.replace(/[<>]/g, '');
        }
        const keys = Object.keys(set);
        if (!keys.length) return p;
        db.prepare(`UPDATE creator_tip_profiles SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, revision = revision + 1, updated_at = @at WHERE creator_subject = @s`)
            .run({ ...set, at: iso(ctx.now()), s: subject });
        return bySubject(subject);
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
        if (owner) Object.assign(out, { revision: p.revision, created_at: p.created_at, updated_at: p.updated_at });
        return out;
    }

    return { bySubject, byHandle, resolve, ensure, update, present, normalizeHandle };
}

function safeUrl(u) {
    if (!u) return null;
    try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString().slice(0, 500) : null; } catch { return null; }
}

module.exports = { createProfiles, normalizeHandle, RESERVED, VOICES, safeUrl, PAGE_DEFAULTS, pageSettings };
