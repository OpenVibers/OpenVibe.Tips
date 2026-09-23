'use strict';

/**
 * Pages and overlay endpoints.
 *
 *   GET  /                          home
 *   GET  /dashboard                 creator dashboard (sign-in; opens the profile on first visit)
 *   POST /dashboard/…               profile, goals, overlay tokens/configs, simulation (anti-forgery token)
 *   GET  /receipts, /receipts/:id   the signed-in supporter's receipts (a creator may open theirs too)
 *   GET  /:handle                   creator page: goals + tip form (indexable only when the page is on)
 *   GET  /:handle/goals             goals
 *   POST /:handle/tip               the no-JS tip form → Billing (credit or checkout)
 *   GET  /overlay/:token            the overlay page for OBS (token = scoped, revocable, never a cookie)
 *   GET  /overlay/:token/events     SSE: alerts and goal updates (Last-Event-ID resumes/replays)
 *   GET  /overlay/:token/state      JSON: active goals and recent alerts (read-only, for other overlay clients)
 *   GET  /robots.txt, /sitemap.xml
 */
const crypto = require('crypto');
const express = require('express');
const { TipsError, json: parseJson } = require('../util');
const { viewerMiddleware } = require('./session');
const pages = require('./pages');
const { esc, asset } = require('./layout');

const FLASH = new Set(['Saved', 'Page settings saved', 'Goal added', 'Goal updated', 'Goal closed', 'Overlay link revoked', 'Alert settings saved', 'Test sent — check your overlay']);

function createWebRoutes({ domain, config, layout, userAuth }) {
    const r = express.Router();
    const { profiles, goals, interactions, overlays, db } = domain;
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

    // ── Home, robots, sitemap ────────────────────────────────
    r.get('/', withViewer, (req, res) => {
        const creators = db.prepare(`SELECT handle, display_name, avatar_url FROM creator_tip_profiles WHERE page_enabled = 1 ORDER BY updated_at DESC LIMIT 24`).all();
        html(res, pageFor(req, { active: 'home', canonicalPath: '/', body: pages.home({ creators }) }));
    });
    r.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(
        `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /receipts\nDisallow: /overlay/\nDisallow: /auth/\nDisallow: /api/\nDisallow: /internal/\nSitemap: ${config.baseUrl}/sitemap.xml\n`));
    r.get('/sitemap.xml', (req, res) => {
        const rows = db.prepare('SELECT handle, updated_at FROM creator_tip_profiles WHERE page_enabled = 1 ORDER BY handle').all();
        const urls = [`<url><loc>${esc(config.baseUrl)}/</loc></url>`, ...rows.map((p) => `<url><loc>${esc(`${config.baseUrl}/${p.handle}`)}</loc><lastmod>${esc(p.updated_at.slice(0, 10))}</lastmod></url>`)];
        res.type('application/xml').set('Cache-Control', 'public, max-age=900').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>\n`);
    });

    // ── Receipts ─────────────────────────────────────────────
    const decorate = (i) => {
        const p = profiles.bySubject(i.creator_subject);
        return { ...interactions.present(i, { viewer: 'supporter' }), creator_handle: p && p.handle, creator_name: p && p.display_name };
    };
    r.get('/receipts', withViewer, (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/receipts')}`);
        const out = interactions.list({ supporter: req.viewer.subject, cursor: req.query.cursor, limit: 50 });
        html(res, pageFor(req, { title: 'Receipts', active: 'receipts', robots: 'noindex,nofollow', canonicalPath: '/receipts', body: pages.receiptsPage({ rows: out.rows.map(decorate), next: out.next_cursor }) }));
    });
    r.get('/receipts/:id', withViewer, (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const i = interactions.get(req.params.id);
        const as = i && (i.supporter_subject === req.viewer.subject ? 'supporter' : i.creator_subject === req.viewer.subject ? 'creator' : null);
        if (!i || !as) return notFound(req, res);
        const view = interactions.present(i, { viewer: as === 'creator' ? 'owner' : 'supporter' });
        html(res, pageFor(req, { title: 'Receipt', active: 'receipts', robots: 'noindex,nofollow', canonicalPath: `/receipts/${i.id}`, body: pages.receiptPage({ i: view, profile: profiles.bySubject(i.creator_subject), as, cancelled: req.query.cancelled === '1' }) }));
    });

    // ── Dashboard ────────────────────────────────────────────
    function ensureProfile(req) {
        const v = req.viewer;
        const claims = req.viewerClaims || {};
        return profiles.ensure(v.subject, { username: v.username, displayName: v.name, avatarUrl: claims.avatar_url });
    }
    function ensureAlertsConfig(subject) {
        if (!overlays.listConfigs(subject).some((c) => c.kind === 'alerts')) overlays.createConfig(subject, { kind: 'alerts', name: 'Alerts' });
    }
    function renderDashboard(req, res, { flash, error, status = 200 } = {}) {
        const p = ensureProfile(req);
        ensureAlertsConfig(p.creator_subject);
        const recent = interactions.list({ creator: p.creator_subject, limit: 20 }).rows.map((i) => interactions.present(i, { viewer: 'owner' }));
        html(res, pageFor(req, {
            title: 'Dashboard', active: 'dashboard', robots: 'noindex,nofollow', canonicalPath: '/dashboard',
            body: pages.dashboard({
                profile: p, goals: goals.list(p.creator_subject).map((g) => goals.present(g)), tokens: overlays.listTokens(p.creator_subject).map(overlays.presentToken),
                configs: overlays.listConfigs(p.creator_subject).map(overlays.presentConfig), totals: interactions.totals(p.creator_subject), recent,
                deliveries: overlays.recentDeliveries(p.creator_subject, 20), csrf: csrfFor(req.viewer.subject), idem: idem(), flash, error,
                connected: overlays.connected(p.creator_subject), chatAdapter: config.chat.adapter,
            }),
        }), status);
    }
    r.get('/dashboard', withViewer, (req, res) => {
        if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/dashboard')}`);
        // Only our own confirmations are shown: a crafted ?done= link cannot put words on the page.
        renderDashboard(req, res, { flash: FLASH.has(String(req.query.done || '')) ? String(req.query.done) : null });
    });

    /** A dashboard form action: sign-in + anti-forgery, errors re-render the dashboard. */
    function action(path, fn) {
        r.post(path, withViewer, form, (req, res) => {
            if (!req.viewer) return res.redirect(`/auth/login?next=${encodeURIComponent('/dashboard')}`);
            if (!csrfOk(req)) return renderDashboard(req, res, { error: 'That form expired. Please try again.', status: 403 });
            try {
                const p = ensureProfile(req);
                const out = fn(req, p);
                if (out && out.render) return out.render(res);
                return res.redirect(303, `/dashboard?done=${encodeURIComponent((out && out.done) || 'Saved')}`);
            } catch (e) {
                if (e instanceof TipsError) return renderDashboard(req, res, { error: e.detail || e.message, status: e.status >= 500 ? 500 : 400 });
                throw e;
            }
        });
    }
    const bool = (v) => v === '1' || v === 'on';
    action('/dashboard/profile', (req, p) => {
        const b = req.body;
        profiles.update(p.creator_subject, {
            page_enabled: bool(b.page_enabled), accepting: bool(b.accepting), tts_enabled: bool(b.tts_enabled), media_requests_enabled: bool(b.media_requests_enabled),
            headline: b.headline, min_amount: b.min_amount, paid_message_min: b.paid_message_min, tts_min_amount: b.tts_min_amount, tts_max_chars: b.tts_max_chars,
            tts_voice: b.tts_voice, media_request_min: b.media_request_min, media_max_seconds: b.media_max_seconds,
        }, { expectedRevision: b.revision });
        return { done: 'Page settings saved' };
    });
    action('/dashboard/goals', (req, p) => { goals.create(p.creator_subject, req.body); return { done: 'Goal added' }; });
    const ownGoal = (req, p) => {
        const g = goals.get(req.params.id);
        if (!g || g.creator_subject !== p.creator_subject) throw new TipsError(404, 'tips.goal_not_found', 'no such goal');
        return g;
    };
    action('/dashboard/goals/:id', (req, p) => { goals.update(ownGoal(req, p), { title: req.body.title, target_amount: req.body.target_amount, revision: req.body.revision }); return { done: 'Goal updated' }; });
    action('/dashboard/goals/:id/close', (req, p) => { goals.close(ownGoal(req, p)); return { done: 'Goal closed' }; });
    action('/dashboard/overlay-tokens', (req, p) => {
        const scopes = [bool(req.body.scope_alerts) && 'alerts', bool(req.body.scope_goals) && 'goals'].filter(Boolean);
        const alertCfg = overlays.listConfigs(p.creator_subject).find((c) => c.kind === 'alerts');
        const out = overlays.createToken(p.creator_subject, { scopes, label: req.body.label, configId: alertCfg ? alertCfg.id : null, createdBy: req.viewer.subject });
        return { render: (res) => html(res, pageFor(req, { title: 'Overlay link', active: 'dashboard', robots: 'noindex,nofollow', canonicalPath: '/dashboard', body: pages.tokenCreated({ out }) }), 201, { 'Cache-Control': 'no-store' }) };
    });
    action('/dashboard/overlay-tokens/:id/revoke', (req, p) => {
        const t = overlays.getToken(req.params.id);
        if (!t || t.creator_subject !== p.creator_subject) throw new TipsError(404, 'tips.overlay_token_not_found', 'no such overlay token');
        overlays.revokeToken(t);
        return { done: 'Overlay link revoked' };
    });
    action('/dashboard/overlay-configs/:id', (req, p) => {
        const c = overlays.getConfig(req.params.id);
        if (!c || c.creator_subject !== p.creator_subject) throw new TipsError(404, 'tips.overlay_config_not_found', 'no such overlay config');
        const b = req.body;
        overlays.updateConfig(c, { ...b, show_message: bool(b.show_message), speak_message: bool(b.speak_message), show_amount: bool(b.show_amount) });
        return { done: 'Alert settings saved' };
    });
    action('/dashboard/simulate', (req, p) => {
        const b = req.body;
        interactions.simulate(p, {
            kind: b.kind, amount: b.amount, message: b.message, supporter_name: b.supporter_name,
            tts: b.kind === 'tts' ? { text: b.message } : undefined, media: b.kind === 'media_request' ? { url: b.media_url } : undefined,
        }, { by: req.viewer.subject });
        return { done: 'Test sent — check your overlay' };
    });

    // ── Overlays (token in the path; no cookies involved) ────
    const overlayHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
    function tokenOr404(req, res) {
        const t = overlays.authenticate(req.params.token);
        if (!t) { res.status(404).set(overlayHeaders).type('text/plain').send('This overlay link is not valid (it may have been revoked).'); return null; }
        return t;
    }
    r.get('/overlay/:token', (req, res) => {
        const t = tokenOr404(req, res);
        if (!t) return;
        res.status(200).set({ ...overlayHeaders, 'Content-Type': 'text/html; charset=utf-8' }).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenVibe.Tips overlay</title>
<link rel="stylesheet" href="${asset('css/overlay.css')}"></head>
<body class="overlay"><div id="goals" aria-live="polite"></div><div id="alert" aria-live="assertive"></div>
<noscript><p class="nojs">This overlay needs JavaScript (OBS Browser Sources have it on).</p></noscript>
<script src="${asset('js/overlay.js')}" defer></script></body></html>`);
    });
    r.get('/overlay/:token/events', (req, res) => {
        const t = tokenOr404(req, res);
        if (!t) return;
        res.status(200).set({ ...overlayHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        res.write('retry: 3000\n\n');
        const config = t.config_id ? overlays.getConfig(t.config_id) : null;
        const lastEventId = req.get('last-event-id') != null ? req.get('last-event-id') : req.query.last_event_id;
        overlays.attach(t, res, { lastEventId: lastEventId != null && lastEventId !== '' ? lastEventId : undefined, config });
    });
    r.get('/overlay/:token/state', (req, res) => {
        const t = tokenOr404(req, res);
        if (!t) return;
        const out = { creator: { type: 'user', id: t.creator_subject }, scopes: t.scopes };
        if (t.scopes.includes('goals')) out.goals = goals.list(t.creator_subject, { status: 'active' }).map((g) => goals.present(g));
        if (t.scopes.includes('alerts')) {
            out.alerts = db.prepare("SELECT seq, payload, test, created_at FROM overlay_deliveries WHERE creator_subject = ? AND kind = 'alert' ORDER BY seq DESC LIMIT 20")
                .all(t.creator_subject).map((d) => ({ seq: d.seq, ...parseJson(d.payload, {}), test: !!d.test, created_at: d.created_at }));
        }
        res.set(overlayHeaders).json(out);
    });

    // ── Creator pages (last: /:handle catches everything else) ──
    const providers = config.billing.providers;
    function creatorView(req, res, { values, error, status = 200 } = {}) {
        const p = profiles.byHandle(req.params.handle);
        const owner = !!(p && req.viewer && req.viewer.subject === p.creator_subject);
        if (!p || (!p.page_enabled && !owner)) return notFound(req, res);
        if (p.handle !== String(req.params.handle)) return res.redirect(301, `/${p.handle}`);   // @name, Name → the canonical path
        const list = goals.list(p.creator_subject).map((g) => goals.present(g));
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
    r.get('/:handle/goals', withViewer, (req, res, next) => {
        const p = profiles.byHandle(req.params.handle);
        if (!p) return next();
        const owner = req.viewer && req.viewer.subject === p.creator_subject;
        if (!p.page_enabled && !owner) return notFound(req, res);
        html(res, pageFor(req, {
            title: `${p.display_name} — goals`, canonicalPath: `/${p.handle}/goals`, robots: p.page_enabled ? 'index,follow' : 'noindex,nofollow',
            body: pages.goalsPage({ profile: p, goals: goals.list(p.creator_subject).map((g) => goals.present(g)) }),
        }));
    });

    r.post('/:handle/tip', withViewer, form, async (req, res, next) => {
        const p = profiles.byHandle(req.params.handle);
        if (!p) return next();
        if (!req.viewer) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/${p.handle}`)}`);
        const b = req.body || {};
        const values = { kind: b.kind, amount: b.amount, message: b.message, tts_text: b.tts_text, tts_voice: b.tts_voice, media_url: b.media_url, goal_id: b.goal_id, pay_with: b.pay_with, supporter_name: b.supporter_name };
        if (!csrfOk(req)) return creatorView(req, res, { values, error: 'That form expired. Please send it again.', status: 403 });
        const owner = req.viewer.subject === p.creator_subject;
        if (!p.page_enabled && !owner) return notFound(req, res);
        const key = /^form-[A-Za-z0-9_-]{8,40}$/.test(String(b.idem || '')) ? `form:${req.viewer.subject}:${b.idem}` : null;
        try {
            const input = {
                kind: b.kind || 'tip', amount: b.amount, message: b.message, goal_id: b.goal_id || undefined,
                tts: b.kind === 'tts' ? { text: b.tts_text || b.message, voice: b.tts_voice } : undefined,
                media: b.kind === 'media_request' ? { url: b.media_url } : undefined,
            };
            const funding = b.pay_with === 'checkout' ? 'checkout' : 'credit';
            const { interaction, replay } = interactions.request(p, input, { supporter: req.viewer.subject, supporterName: b.supporter_name || req.viewer.name, funding, idempotencyKey: key });
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
