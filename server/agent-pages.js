'use strict';
// The Markdown twins of openvibe.tips' public pages (openvibe-shared/agent-layer), rendered by the same
// data readers and page builders the routes use (web/pages.js through web/layout.js), signed out so a
// twin can never carry a viewer's tip form or a creator's private preview. Private pages (dashboard,
// receipts, moderation, overlays, auth, API) are never rendered here; a creator page that is switched
// off has no twin.
const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');
const frame = require('openvibe-shared/frame');
const ovServe = require('openvibe-shared/serve');
const pages = require('./web/pages');

const HOME_DESCRIPTION = 'Tip the creators you watch: paid messages, text-to-speech, media requests and sounds, with goals and alert overlays for OBS on any streaming app.';

function createAgentPages({ domain, config, layout, liveNow = { list: async () => [] } }) {
    const { profiles, goals, interactions, sounds, db } = domain;
    const twin = (o) => ({ html: layout.page({ ...o, viewer: null }) });

    async function home() {
        const [rows, live] = await Promise.all([
            db.many(sql`SELECT creator_subject, handle, display_name, avatar_url, headline FROM creator_tip_profiles WHERE page_enabled ORDER BY updated_at DESC LIMIT 24`),
            liveNow.list(),
        ]);
        const creators = await Promise.all(rows.map(async (p) => {
            const [goal] = await goals.presentMany(db, (await goals.list(db, p.creator_subject, { status: 'active' })).slice(0, 1));
            return { handle: p.handle, display_name: p.display_name, avatar_url: p.avatar_url, headline: p.headline, goal: goal ? { title: goal.title, percent: goal.percent } : null };
        }));
        return twin({
            active: 'home', canonicalPath: '/', title: 'Tips, paid messages and stream alerts', description: HOME_DESCRIPTION,
            styles: [require('openvibe-shared/showcase').STYLESHEET], wide: true, body: pages.home({ creators, live }),
        });
    }

    function updates() {
        return twin({ canonicalPath: '/updates', title: 'What shipped on OpenVibe.Tips', body: frame.updatesBody({ service: 'tips', siteName: 'OpenVibe.Tips' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>` });
    }

    async function creator(handle) {
        const p = await profiles.byHandle(db, handle);
        if (!p || !p.page_enabled) return null;
        const list = await goals.publicGoals(db, await goals.list(db, p.creator_subject), p);
        const publicSounds = p.sounds_enabled ? await sounds.list(db, p.creator_subject) : [];
        return twin({
            title: `Support ${p.display_name}`, active: 'creator', canonicalPath: `/${p.handle}`,
            description: p.headline || `Tip ${p.display_name} on OpenVibe.Tips: tips, goals, paid messages${p.tts_enabled ? ', text-to-speech' : ''}${p.media_requests_enabled ? ', media requests' : ''}.`,
            robots: 'index,follow', ogImage: p.avatar_url || undefined,
            body: pages.creatorPage({
                profile: p, goals: list, viewer: null, csrf: '', idem: `agent-${crypto.randomBytes(12).toString('base64url')}`,
                values: {}, providers: config.billing.providers, error: null, ownerPreview: false, sounds: publicSounds,
            }),
        });
    }

    async function creatorGoals(handle) {
        const p = await profiles.byHandle(db, handle);
        if (!p || !p.page_enabled) return null;
        return twin({
            title: `${p.display_name} — goals`, canonicalPath: `/${p.handle}/goals`, robots: 'index,follow',
            body: pages.goalsPage({ profile: p, goals: await goals.publicGoals(db, await goals.list(db, p.creator_subject), p) }),
        });
    }

    async function creatorSupporters(handle) {
        const p = await profiles.byHandle(db, handle);
        if (!p || !p.page_enabled || !p.page.supporters_page) return null;
        const [top, recentRows] = await Promise.all([interactions.leaderboard(db, p), p.page.supporters_messages ? interactions.recentPublic(db, p) : null]);
        const leaderboard = top.map((row) => (p.page.supporters_amounts ? row : { ...row, total: null }));
        const recent = recentRows ? recentRows.map((v) => (p.page.supporters_amounts ? v : { ...v, amount: null })) : null;
        return twin({
            title: `${p.display_name} — supporters`, canonicalPath: `/${p.handle}/supporters`, robots: 'index,follow',
            body: pages.supportersPage({ profile: p, leaderboard, recent }),
        });
    }

    async function renderPublicPage(path) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (p === '/') return home();
        if (p === '/updates') return updates();
        const m = /^\/([^/]+)(\/goals|\/supporters)?$/.exec(p);
        if (!m) return null;
        const handle = profiles.normalizeHandle(m[1]);
        if (!handle) return null;
        if (m[2] === '/goals') return creatorGoals(handle);
        if (m[2] === '/supporters') return creatorSupporters(handle);
        return creator(handle);
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
