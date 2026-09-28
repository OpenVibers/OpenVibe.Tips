'use strict';

/**
 * Pages and overlay endpoints.
 *
 *   GET  /                          home
 *   GET  /dashboard                 creator dashboard (sign-in; opens the profile on first visit)
 *   POST /dashboard/…               profile, goals, overlay tokens/configs, simulation (anti-forgery token)
 *   GET  /receipts, /receipts/:id   the signed-in supporter's receipts (a creator may open theirs too)
 *   GET  /receipts/export           the supporter's tips as a JSON download
 *   GET|POST /receipts/erase        erase the supporter's data from their tips (confirmation, anti-forgery token)
 *   GET  /:handle                   creator page: goals + tip form (indexable only when the page is on)
 *   GET  /:handle/goals             goals (as the creator chose to show them)
 *   GET  /:handle/supporters        top supporters and recent public messages, when the creator shows them
 *   GET  /moderate/:handle          paid messages to review (the creator and their moderators)
 *   POST /moderate/:handle/:id/hide|restore
 *   GET|POST /moderate/invite/:token   accept a moderator invitation (show-once link, never logged by nginx)
 *   POST /:handle/tip               the no-JS tip form → Billing (credit or checkout)
 *   GET  /overlay/:token            the overlay page for OBS (token = scoped, revocable, never a cookie)
 *   GET  /overlay/:token/events     SSE: alerts and goal updates (Last-Event-ID resumes/replays)
 *   GET  /overlay/:token/state      JSON: active goals and recent alerts (read-only, for other overlay clients)
 *   GET  /robots.txt, /sitemap.xml
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const express = require('express');
const { sql } = require('openvibe-sdk/db');
const { TipsError } = require('../util');
const { viewerMiddleware } = require('./session');
const { asyncRouter } = require('./async-router');
const pages = require('./pages');
const { esc, asset } = require('./layout');
const { PAGE_DEFAULTS } = require('../domain/profiles');

const FLASH = new Set(['Saved', 'Page settings saved', 'Goal added', 'Goal updated', 'Goal closed', 'Overlay link revoked', 'Alert settings saved', 'Test sent — check your overlay',
    'Filter saved', 'Moderator removed', 'Invitation revoked']);
const MOD_FLASH = new Set(['Hidden', 'Shown', 'You are now a moderator']);
const RECEIPT_FLASH = new Set(['Your data was erased from your tips']);

function createWebRoutes({ domain, config, layout, userAuth }) {
    // Every handler below may be async: its errors reach the app's error handler (the 500 page).
    const r = asyncRouter(express.Router());
    const { profiles, goals, interactions, overlays, moderation, db } = domain;
    const withViewer = viewerMiddleware(userAuth);
    const form = express.urlencoded({ extended: false, limit: '32kb' });
    const secret = config.formSecret || crypto.randomBytes(32).toString('hex');

    const html = (res, body, status = 200, extraHeaders = {}) => res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...extraHeaders }).send(body);
    const pageFor = (req, o) => layout.page({ viewer: req.viewer, ...o });
    const notFound = (req, res) => html(res, pageFor(req, { title: 'Not found', robots: 'noindex', body: pages.errorPage({ status: 404, title: 'Nothing here', message: 'That page does not exist, or its creator has not switched it on.' }) }), 404);

    // Anti-forgery for signed-in forms: HMAC(subject, day), valid today and yesterday.
    const day = () => Math.floor(domain.now() / 86_400_000);
    const csrfFor = (subject, d = day()) => crypto.createHmac('sha256', secret).update(`${subject}|${d}`).digest('base64url');
    function csrfOk(req) {
        if (!req.viewer) return false;
        const origin = req.get('origin');
        if (origin && origin !== new URL(config.baseUrl).origin) return false;
        const given = String((req.body && req.body.csrf) || '');
        return [day(), day() - 1].some((d) => {
            const want = csrfFor(req.viewer.subject, d);
            return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
        });
    }
    const idem = () => `form-${crypto.randomBytes(12).toString('base64url')}`;
    const bool = (v) => v === '1' || v === 'on' || v === true;

    // ── Home, robots, sitemap ────────────────────────────────
    r.get('/', withViewer, async (req, res) => {
        const creators = await db.many(sql`SELECT handle, display_name, avatar_url FROM creator_tip_profiles WHERE page_enabled ORDER BY updated_at DESC LIMIT 24`);
        html(res, pageFor(req, { active: 'home', canonicalPath: '/', body: pages.home({ creators }) }));
    });
    // What shipped on OpenVibe.Tips: the shared update log every OpenVibe site has.
    r.get('/updates', withViewer, (req, res) => html(res, pageFor(req, { canonicalPath: '/updates', title: 'What shipped on OpenVibe.Tips', body: frame.updatesBody({ service: 'tips', siteName: 'OpenVibe.Tips' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>` })));
    r.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(
        `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /receipts\nDisallow: /overlay/\nDisallow: /moderate/\nDisallow: /auth/\nDisallow: /api/\nDisallow: /internal/\nSitemap: ${config.baseUrl}/sitemap.xml\n`));
    r.get('/sitemap.xml', async (req, res) => {
        const rows = await db.many(sql`SELECT handle, updated_at FROM creator_tip_profiles WHERE page_enabled ORDER BY handle`);
        const urls = [`<url><loc>${esc(config.baseUrl)}/</loc></url>`, ...rows.map((p) => `<url><loc>${esc(`${config.baseUrl}/${p.handle}`)}</loc><lastmod>${esc(p.updated_at.slice(0, 10))}</lastmod></url>`)];
        res.type('application/xml').set('Cache-Control', 'public, max-age=900').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>\n`);
    });

    // ── Receipts ─────────────────────────────────────────────
    /** The supporter's view of each receipt, with its creator's handle and name (one query for all creators). */
    async function decorate(rows) {
        const [views, byCreator] = await Promise.all([
            interactions.presentMany(db, rows, { viewer: 'supporter' }),
            profiles.bySubjects(db, rows.map((i) => i.creator_subject)),
        ]);
        return views.map((v, k) => { const p = byCreator.get(rows[k].creator_subject); return { ...v, creator_handle: p && p.handle, creator_name: p && p.display_name }; });
    }
    r.get('/receipts', withViewer, async (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/receipts')}`);
        const out = await interactions.list(db, { supporter: req.viewer.subject, cursor: req.query.cursor, limit: 50 });
        const flash = RECEIPT_FLASH.has(String(req.query.done || '')) ? String(req.query.done) : null;
        return html(res, pageFor(req, { title: 'Receipts', active: 'receipts', robots: 'noindex,nofollow', canonicalPath: '/receipts', body: pages.receiptsPage({ rows: await decorate(out.rows), next: out.next_cursor, flash }) }));
    });
    // The supporter's own data: a download, and erasure (privacy.js, interactions.erase()).
    r.get('/receipts/export', withViewer, async (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/receipts')}`);
        const today = new Date(domain.now()).toISOString().slice(0, 10);
        return res.status(200).set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="openvibe-tips-${today}.json"`, 'X-Robots-Tag': 'noindex, nofollow' })
            .type('application/json').send(`${JSON.stringify(await interactions.exportFor(req.viewer.subject), null, 2)}\n`);
    });
    async function renderErase(req, res, status = 200) {
        const c = await db.one(sql`SELECT count(*) AS n, count(*) FILTER (WHERE payment_state = 'pending') AS pending FROM tip_interactions WHERE supporter_subject = ${req.viewer.subject}`);
        html(res, pageFor(req, {
            title: 'Erase your data', active: 'receipts', robots: 'noindex,nofollow', canonicalPath: '/receipts/erase',
            body: pages.erasePage({ csrf: csrfFor(req.viewer.subject), idem: idem(), count: c.n, pending: c.pending }),
        }), status);
    }
    r.get('/receipts/erase', withViewer, async (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/receipts/erase')}`);
        return renderErase(req, res);
    });
    r.post('/receipts/erase', withViewer, form, async (req, res) => {
        if (!req.viewer) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/receipts/erase')}`);
        if (!csrfOk(req) || !bool(req.body.confirm)) return renderErase(req, res, 403);
        await interactions.erase(req.viewer.subject);
        return res.redirect(303, `/receipts?done=${encodeURIComponent('Your data was erased from your tips')}`);
    });
    r.get('/receipts/:id', withViewer, async (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const i = await interactions.get(db, req.params.id);
        const as = i && (i.supporter_subject === req.viewer.subject ? 'supporter' : i.creator_subject === req.viewer.subject ? 'creator' : null);
        if (!i || !as) return notFound(req, res);
        const [view, profile] = await Promise.all([interactions.present(db, i, { viewer: as === 'creator' ? 'owner' : 'supporter' }), profiles.bySubject(db, i.creator_subject)]);
        return html(res, pageFor(req, { title: 'Receipt', active: 'receipts', robots: 'noindex,nofollow', canonicalPath: `/receipts/${i.id}`, body: pages.receiptPage({ i: view, profile, as, cancelled: req.query.cancelled === '1' }) }));
    });

    // ── Dashboard ────────────────────────────────────────────
    function ensureProfile(req) {
        const v = req.viewer;
        const claims = req.viewerClaims || {};
        return profiles.ensure(v.subject, { username: v.username, displayName: v.name, avatarUrl: claims.avatar_url });
    }
    async function renderDashboard(req, res, { flash, error, status = 200 } = {}) {
        const p = await ensureProfile(req);
        let configs = await overlays.listConfigs(db, p.creator_subject);
        if (!configs.some((c) => c.kind === 'alerts')) {
            await overlays.createConfig(p.creator_subject, { kind: 'alerts', name: 'Alerts' });
            configs = await overlays.listConfigs(db, p.creator_subject);
        }
        const s = p.creator_subject;
        const [recentRows, goalRows, tokens, totals, deliveries, connected, held, moderators, invites, log, moderating] = await Promise.all([
            interactions.list(db, { creator: s, limit: 20 }).then((out) => interactions.presentMany(db, out.rows, { viewer: 'owner' })),
            goals.list(db, s).then((list) => goals.presentMany(db, list)),
            overlays.listTokens(db, s), interactions.totals(db, s), overlays.recentDeliveries(db, s, 20), overlays.connected(s),
            moderation.heldCount(db, s), moderation.listModerators(db, s), moderation.openInvites(db, s), moderation.log(db, s, 20), moderation.moderatedBy(db, req.viewer.subject),
        ]);
        html(res, pageFor(req, {
            title: 'Dashboard', active: 'dashboard', robots: 'noindex,nofollow', canonicalPath: '/dashboard',
            body: pages.dashboard({
                profile: p, goals: goalRows, tokens: tokens.map(overlays.presentToken),
                configs: configs.map(overlays.presentConfig), totals, recent: recentRows,
                deliveries, csrf: csrfFor(req.viewer.subject), idem: idem(), flash, error,
                connected, chatAdapter: config.chat.adapter,
                mod: { held, moderators: moderators.map(moderation.presentModerator), invites, log, moderating },
            }),
        }), status);
    }
    r.get('/dashboard', withViewer, async (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/dashboard')}`);
        // Only our own confirmations are shown: a crafted ?done= link cannot put words on the page.
        return renderDashboard(req, res, { flash: FLASH.has(String(req.query.done || '')) ? String(req.query.done) : null });
    });

    /** A dashboard form action: sign-in + anti-forgery, errors re-render the dashboard. */
    function action(path, fn) {
        r.post(path, withViewer, form, async (req, res) => {
            if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/dashboard')}`);
            if (!csrfOk(req)) return renderDashboard(req, res, { error: 'That form expired. Please try again.', status: 403 });
            try {
                const p = await ensureProfile(req);
                const out = await fn(req, p);
                if (out && out.render) return out.render(res);
                return res.redirect(303, `/dashboard?done=${encodeURIComponent((out && out.done) || 'Saved')}`);
            } catch (e) {
                if (e instanceof TipsError) return renderDashboard(req, res, { error: e.detail || e.message, status: e.status >= 500 ? 500 : 400 });
                throw e;
            }
        });
    }
    action('/dashboard/profile', async (req, p) => {
        const b = req.body;
        await profiles.update(p.creator_subject, {
            page_enabled: bool(b.page_enabled), accepting: bool(b.accepting), tts_enabled: bool(b.tts_enabled), media_requests_enabled: bool(b.media_requests_enabled),
            headline: b.headline, min_amount: b.min_amount, paid_message_min: b.paid_message_min, tts_min_amount: b.tts_min_amount, tts_max_chars: b.tts_max_chars,
            tts_voice: b.tts_voice, media_request_min: b.media_request_min, media_max_seconds: b.media_max_seconds,
            page: Object.fromEntries(Object.keys(PAGE_DEFAULTS).map((k) => [k, bool(b[`page_${k}`])])),
        }, { expectedRevision: b.revision });
        return { done: 'Page settings saved' };
    });
    action('/dashboard/goals', async (req, p) => { await goals.create(p.creator_subject, req.body); return { done: 'Goal added' }; });
    const ownGoal = async (req, p) => {
        const g = await goals.get(db, req.params.id);
        if (!g || g.creator_subject !== p.creator_subject) throw new TipsError(404, 'tips.goal_not_found', 'no such goal');
        return g;
    };
    action('/dashboard/goals/:id', async (req, p) => { await goals.update(await ownGoal(req, p), { title: req.body.title, target_amount: req.body.target_amount, revision: req.body.revision }); return { done: 'Goal updated' }; });
    action('/dashboard/goals/:id/close', async (req, p) => { await goals.close(await ownGoal(req, p)); return { done: 'Goal closed' }; });
    action('/dashboard/overlay-tokens', async (req, p) => {
        const scopes = [bool(req.body.scope_alerts) && 'alerts', bool(req.body.scope_goals) && 'goals'].filter(Boolean);
        const alertCfg = (await overlays.listConfigs(db, p.creator_subject)).find((c) => c.kind === 'alerts');
        const out = await overlays.createToken(p.creator_subject, { scopes, label: req.body.label, configId: alertCfg ? alertCfg.id : null, createdBy: req.viewer.subject });
        return { render: (res) => html(res, pageFor(req, { title: 'Overlay link', active: 'dashboard', robots: 'noindex,nofollow', canonicalPath: '/dashboard', body: pages.tokenCreated({ out }) }), 201, { 'Cache-Control': 'no-store' }) };
    });
    action('/dashboard/overlay-tokens/:id/revoke', async (req, p) => {
        const t = await overlays.getToken(db, req.params.id);
        if (!t || t.creator_subject !== p.creator_subject) throw new TipsError(404, 'tips.overlay_token_not_found', 'no such overlay token');
        await overlays.revokeToken(t);
        return { done: 'Overlay link revoked' };
    });
    action('/dashboard/overlay-configs/:id', async (req, p) => {
        const c = await overlays.getConfig(db, req.params.id);
        if (!c || c.creator_subject !== p.creator_subject) throw new TipsError(404, 'tips.overlay_config_not_found', 'no such overlay config');
        const b = req.body;
        await overlays.updateConfig(c, { ...b, show_message: bool(b.show_message), speak_message: bool(b.speak_message), show_amount: bool(b.show_amount) });
        return { done: 'Alert settings saved' };
    });
    action('/dashboard/filter', async (req, p) => {
        await profiles.update(p.creator_subject, { filter: { words: req.body.words || '', action: req.body.action, links: bool(req.body.links) } });
        return { done: 'Filter saved' };
    });
    action('/dashboard/moderators/:subject/remove', async (req, p) => { await moderation.removeModerator(p.creator_subject, req.params.subject); return { done: 'Moderator removed' }; });
    action('/dashboard/moderator-invites', async (req, p) => {
        const out = await moderation.createInvite(p.creator_subject, { createdBy: req.viewer.subject });
        return { render: (res) => html(res, pageFor(req, { title: 'Moderator invitation', active: 'dashboard', robots: 'noindex,nofollow', canonicalPath: '/dashboard', body: pages.inviteCreated({ out }) }), 201, { 'Cache-Control': 'no-store' }) };
    });
    action('/dashboard/moderator-invites/:id/revoke', async (req, p) => { await moderation.revokeInvite(p.creator_subject, req.params.id); return { done: 'Invitation revoked' }; });
    action('/dashboard/simulate', async (req, p) => {
        const b = req.body;
        await interactions.simulate(p, {
            kind: b.kind, amount: b.amount, message: b.message, supporter_name: b.supporter_name,
            tts: b.kind === 'tts' ? { text: b.message } : undefined, media: b.kind === 'media_request' ? { url: b.media_url } : undefined,
        }, { by: req.viewer.subject });
        return { done: 'Test sent — check your overlay' };
    });

    // ── Overlays (token in the path; no cookies involved) ────
    const overlayHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
    async function tokenOr404(req, res) {
        const t = await overlays.authenticate(db, req.params.token);
        if (!t) { res.status(404).set(overlayHeaders).type('text/plain').send('This overlay link is not valid (it may have been revoked).'); return null; }
        return t;
    }
    r.get('/overlay/:token', async (req, res) => {
        const t = await tokenOr404(req, res);
        if (!t) return;
        res.status(200).set({ ...overlayHeaders, 'Content-Type': 'text/html; charset=utf-8' }).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenVibe.Tips overlay</title>
<link rel="stylesheet" href="${asset('css/overlay.css')}"></head>
<body class="overlay"><div id="goals" aria-live="polite"></div><div id="alert" aria-live="assertive"></div>
<noscript><p class="nojs">This overlay needs JavaScript (OBS Browser Sources have it on).</p></noscript>
<script src="${asset('js/overlay.js')}" defer></script></body></html>`);
    });
    r.get('/overlay/:token/events', async (req, res) => {
        const t = await tokenOr404(req, res);
        if (!t) return;
        // A bounded number of open streams per token, counted across every process (overlay-hub.js).
        const slot = await overlays.reserveStream(t);
        if (!slot) {
            res.status(429).set({ ...overlayHeaders, 'Retry-After': '30' }).type('text/plain').send('Too many open streams for this overlay link.');
            return;
        }
        let overlayConfig = null;
        try { overlayConfig = t.config_id ? await overlays.getConfig(db, t.config_id) : null; } catch (e) { overlays.releaseStream(slot); throw e; }
        res.status(200).set({ ...overlayHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        res.write('retry: 3000\n\n');
        const lastEventId = req.get('last-event-id') != null ? req.get('last-event-id') : req.query.last_event_id;
        overlays.attach(t, res, slot, { lastEventId: lastEventId != null && lastEventId !== '' ? lastEventId : undefined, config: overlayConfig });
    });
    r.get('/overlay/:token/state', async (req, res) => {
        const t = await tokenOr404(req, res);
        if (!t) return;
        const out = { creator: { type: 'user', id: t.creator_subject }, scopes: t.scopes };
        if (t.scopes.includes('goals')) out.goals = await goals.presentMany(db, await goals.list(db, t.creator_subject, { status: 'active' }));
        if (t.scopes.includes('alerts')) out.alerts = await overlays.recentAlerts(db, t.creator_subject);
        res.set(overlayHeaders).json(out);
    });

    // ── Moderation (the creator and their moderators) ─────────
    // Invitation links carry a secret in the path, like overlay links: no-store, no referrer, noindex.
    const inviteHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
    async function inviteOr404(req, res) {
        const inv = await moderation.findInvite(db, req.params.token);
        const profile = inv && await profiles.bySubject(db, inv.creator_subject);
        if (!inv || !profile) {
            html(res, pageFor(req, { title: 'Invitation', robots: 'noindex,nofollow', body: pages.errorPage({ status: 404, title: 'This invitation is not valid', message: 'It may have been used, revoked or expired. Ask the creator for a new one.' }) }), 404, inviteHeaders);
            return null;
        }
        return { inv, profile };
    }
    r.get('/moderate/invite/:token', withViewer, async (req, res) => {
        if (!req.viewer) return res.set(inviteHeaders).redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const found = await inviteOr404(req, res);
        if (!found) return undefined;
        return html(res, pageFor(req, {
            title: `Moderate ${found.profile.display_name}`, robots: 'noindex,nofollow', canonicalPath: '/',
            body: pages.invitePage({ profile: found.profile, csrf: csrfFor(req.viewer.subject), idem: idem(), secret: req.params.token, isSelf: found.profile.creator_subject === req.viewer.subject }),
        }), 200, inviteHeaders);
    });
    r.post('/moderate/invite/:token', withViewer, form, async (req, res) => {
        if (!req.viewer) return res.set(inviteHeaders).redirect(303, '/auth/login');
        if (!csrfOk(req)) return html(res, pageFor(req, { title: 'Invitation', robots: 'noindex,nofollow', body: pages.errorPage({ status: 403, title: 'That form expired', message: 'Open the invitation link again.' }) }), 403, inviteHeaders);
        try {
            const out = await moderation.acceptInvite(req.params.token, { subject: req.viewer.subject, name: req.viewer.name || req.viewer.username });
            const profile = await profiles.bySubject(db, out.creator);
            return res.set(inviteHeaders).redirect(303, `/moderate/${encodeURIComponent(profile.handle)}?done=${encodeURIComponent('You are now a moderator')}`);
        } catch (e) {
            if (e instanceof TipsError) return html(res, pageFor(req, { title: 'Invitation', robots: 'noindex,nofollow', body: pages.errorPage({ status: e.status, title: 'This invitation is not valid', message: e.detail || e.message }) }), e.status, inviteHeaders);
            throw e;
        }
    });

    /** The creator or one of their moderators, for /moderate/:handle; else null (the page is a 404). */
    async function modAccess(req) {
        const p = await profiles.byHandle(db, req.params.handle);
        if (!p || !req.viewer) return { p };
        return { p, actor: await moderation.actorFor(db, req.viewer, p.creator_subject, false) };
    }
    async function renderModerate(req, res, p, { error, status = 200 } = {}) {
        const state = ['held', 'hidden', 'visible', 'all'].includes(req.query.state) ? req.query.state : 'all';
        const out = await moderation.queue(db, p.creator_subject, { state, cursor: req.query.cursor, limit: 50 });
        const flash = MOD_FLASH.has(String(req.query.done || '')) ? String(req.query.done) : null;
        html(res, pageFor(req, {
            title: `Paid messages — ${p.display_name}`, robots: 'noindex,nofollow', canonicalPath: `/moderate/${p.handle}`,
            body: pages.moderatePage({ profile: p, rows: out.rows, state, next: out.next_cursor, csrf: csrfFor(req.viewer.subject), idem: idem(), flash, error, isCreator: req.viewer.subject === p.creator_subject }),
        }), status);
    }
    r.get('/moderate/:handle', withViewer, async (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const { p, actor } = await modAccess(req);
        if (!p || !actor) return notFound(req, res);
        return renderModerate(req, res, p);
    });
    r.post('/moderate/:handle/:id/:act(hide|restore)', withViewer, form, async (req, res) => {
        if (!req.viewer) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/moderate/${req.params.handle}`)}`);
        const { p, actor } = await modAccess(req);
        if (!p || !actor) return notFound(req, res);
        if (!csrfOk(req)) return renderModerate(req, res, p, { error: 'That form expired. Please try again.', status: 403 });
        const i = await interactions.get(db, req.params.id);
        if (!i || i.creator_subject !== p.creator_subject) return notFound(req, res);
        try {
            await moderation[req.params.act](i, { ...actor, reason: req.body.reason });
        } catch (e) {
            if (e instanceof TipsError) return renderModerate(req, res, p, { error: e.detail || e.message, status: 400 });
            throw e;
        }
        return res.redirect(303, `/moderate/${encodeURIComponent(p.handle)}?done=${req.params.act === 'hide' ? 'Hidden' : 'Shown'}`);
    });

    // ── Creator pages (last: /:handle catches everything else) ──
    const providers = config.billing.providers;
    async function creatorView(req, res, { values, error, status = 200 } = {}) {
        const p = await profiles.byHandle(db, req.params.handle);
        const owner = !!(p && req.viewer && req.viewer.subject === p.creator_subject);
        if (!p || (!p.page_enabled && !owner)) return notFound(req, res);
        if (p.handle !== String(req.params.handle)) return res.redirect(301, `/${p.handle}`);   // @name, Name → the canonical path
        // The page shows what the public sees, for the creator too (a preview); the dashboard has the rest.
        const list = await goals.publicGoals(db, await goals.list(db, p.creator_subject), p);
        const csrf = req.viewer ? csrfFor(req.viewer.subject) : '';
        const jsonLd = p.page_enabled ? [{ '@context': 'https://schema.org', '@type': 'ProfilePage', name: `${p.display_name} on ${'OpenVibe.Tips'}`, url: `${config.baseUrl}/${p.handle}`, mainEntity: { '@type': 'Person', name: p.display_name, alternateName: p.handle, image: p.avatar_url || undefined } }] : [];
        return html(res, pageFor(req, {
            title: `Support ${p.display_name}`, active: 'creator', canonicalPath: `/${p.handle}`,
            description: p.headline || `Tip ${p.display_name} on OpenVibe.Tips: tips, goals, paid messages${p.tts_enabled ? ', text-to-speech' : ''}${p.media_requests_enabled ? ', media requests' : ''}.`,
            robots: p.page_enabled ? 'index,follow' : 'noindex,nofollow', ogImage: p.avatar_url || undefined, jsonLd,
            body: pages.creatorPage({ profile: p, goals: list, viewer: req.viewer, csrf, idem: idem(), values, providers, error, ownerPreview: !p.page_enabled }),
        }), status, p.page_enabled ? {} : { 'X-Robots-Tag': 'noindex, nofollow' });
    }
    r.get('/:handle', withViewer, (req, res, next) => (profiles.normalizeHandle(req.params.handle) ? creatorView(req, res) : next()));
    r.get('/:handle/goals', withViewer, async (req, res, next) => {
        const p = await profiles.byHandle(db, req.params.handle);
        if (!p) return next();
        const owner = req.viewer && req.viewer.subject === p.creator_subject;
        if (!p.page_enabled && !owner) return notFound(req, res);
        return html(res, pageFor(req, {
            title: `${p.display_name} — goals`, canonicalPath: `/${p.handle}/goals`, robots: p.page_enabled ? 'index,follow' : 'noindex,nofollow',
            body: pages.goalsPage({ profile: p, goals: await goals.publicGoals(db, await goals.list(db, p.creator_subject), p) }),
        }));
    });
    r.get('/:handle/supporters', withViewer, async (req, res, next) => {
        const p = await profiles.byHandle(db, req.params.handle);
        if (!p) return next();
        const owner = req.viewer && req.viewer.subject === p.creator_subject;
        // Off unless the creator shows it; the creator gets a preview while it is off.
        if ((!p.page_enabled || !p.page.supporters_page) && !owner) return notFound(req, res);
        const [top, recentRows] = await Promise.all([interactions.leaderboard(db, p), p.page.supporters_messages ? interactions.recentPublic(db, p) : null]);
        const leaderboard = top.map((row) => (p.page.supporters_amounts ? row : { ...row, total: null }));
        const recent = recentRows ? recentRows.map((v) => (p.page.supporters_amounts ? v : { ...v, amount: null })) : null;
        const indexable = p.page_enabled && p.page.supporters_page;
        return html(res, pageFor(req, {
            title: `${p.display_name} — supporters`, canonicalPath: `/${p.handle}/supporters`, robots: indexable ? 'index,follow' : 'noindex,nofollow',
            body: pages.supportersPage({ profile: p, leaderboard, recent }),
        }), 200, indexable ? {} : { 'X-Robots-Tag': 'noindex, nofollow' });
    });

    r.post('/:handle/tip', withViewer, form, async (req, res, next) => {
        const p = await profiles.byHandle(db, req.params.handle);
        if (!p) return next();
        if (!req.viewer) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/${p.handle}`)}`);
        const b = req.body || {};
        const values = {
            kind: b.kind, amount: b.amount, message: b.message, tts_text: b.tts_text, tts_voice: b.tts_voice, media_url: b.media_url, goal_id: b.goal_id, pay_with: b.pay_with,
            supporter_name: b.supporter_name, anonymous: bool(b.anonymous), hide_amount: bool(b.hide_amount), private_message: bool(b.private_message),
        };
        if (!csrfOk(req)) return creatorView(req, res, { values, error: 'That form expired. Please send it again.', status: 403 });
        const owner = req.viewer.subject === p.creator_subject;
        if (!p.page_enabled && !owner) return notFound(req, res);
        const key = /^form-[A-Za-z0-9_-]{8,40}$/.test(String(b.idem || '')) ? `form:${req.viewer.subject}:${b.idem}` : null;
        try {
            const input = {
                kind: b.kind || 'tip', amount: b.amount, message: b.message, goal_id: b.goal_id || undefined,
                tts: b.kind === 'tts' ? { text: b.tts_text || b.message, voice: b.tts_voice } : undefined,
                media: b.kind === 'media_request' ? { url: b.media_url } : undefined,
                privacy: { anonymous: values.anonymous, hide_amount: values.hide_amount, private_message: values.private_message },
            };
            const funding = b.pay_with === 'checkout' ? 'checkout' : 'credit';
            const { interaction, replay } = await interactions.request(p, input, { supporter: req.viewer.subject, supporterName: b.supporter_name || req.viewer.name, funding, idempotencyKey: key });
            let i = interaction;
            if (!replay) {
                if (funding === 'credit') {
                    const out = await interactions.transfer(i);
                    if (out.refused) {
                        const msg = out.refused === 'billing.insufficient_funds' ? 'Your Vibes balance is too low for this. Pay by checkout instead, or top up on OpenVibe.Live.' : `Billing refused this tip (${out.refused}).`;
                        return creatorView(req, res, { values, error: msg, status: 409 });
                    }
                } else {
                    i = (await interactions.startCheckout(i, { provider: b.provider })).interaction;
                    if (i.checkout_url) return res.redirect(303, i.checkout_url);
                }
            }
            return res.redirect(303, `/receipts/${i.id}`);
        } catch (e) {
            if (e instanceof TipsError) return creatorView(req, res, { values, error: e.detail || e.message, status: e.status >= 500 ? 502 : 400 });
            return next(e);
        }
    });

    return r;
}

module.exports = { createWebRoutes };
