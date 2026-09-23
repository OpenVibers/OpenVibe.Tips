'use strict';

/**
 * OpenVibe.Tips — creator support: tips, goals, paid messages, TTS and media requests, overlays.
 * Express app factory; server/index.js listens, tests build their own instance.
 *
 *   GET  /api/health, /api/ready, /release.json, /metrics (direct loopback callers only)
 *   /api/v1/*                     API (service tokens + user tokens, see api/v1.js)
 *   POST /internal/events         Billing settlement events from OpenVibe.Events (signed webhook + inbox)
 *   /auth/*                       Network SSO session for the pages
 *   /overlay/:token[/events|/state]  overlays (scoped revocable tokens)
 *   /, /dashboard, /receipts, /:handle …  server-rendered pages
 *
 * createApp({ config, db, keys, billing, adapters, now, fetchImpl, log }) — everything injectable.
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { http } = require('openvibe-contracts');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createKeyProvider, createUserAuth } = require('./network');
const { createBillingClient } = require('./billing-client');
const { createAdapters } = require('./delivery');
const { createTipsOutbox } = require('./events/outbox');
const { consumerRouter } = require('./events/consumer');
const { createDomain } = require('./domain');
const { createApiAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { createSessionRoutes } = require('./web/session');
const { createWebRoutes } = require('./web/routes');
const { createLayout, assetVersion } = require('./web/layout');
const pages = require('./web/pages');
const { createTipsReadiness, registerTipsGauges } = require('./observability');

const VERSION = require('../package.json').version;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const db = opts.db || openDb(config.dbPath);
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const userAuth = createUserAuth(config, keys);
    const billing = opts.billing || createBillingClient(config, { fetchImpl });
    const adapters = opts.adapters || createAdapters(config, { fetchImpl });
    const outbox = opts.outbox || createTipsOutbox({ db, config, fetchImpl: opts.eventsFetch, now, log });
    const domain = createDomain({ db, config, outbox, billing, adapters, now, log });
    const apiAuth = createApiAuth({ config, keys, userAuth });
    const release = require('openvibe-shared/release').createRelease({ service: 'tips', root: path.join(__dirname, '..') });
    const layout = createLayout({ config, release });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // HTTP golden signals by route template, process metrics, release_info; GET /metrics answers
    // direct loopback callers only (Track O). An overlay's SSE stream is a session, not a request.
    const metrics = require('openvibe-shared/metrics').instrument(app, {
        service: 'tips', release: release.release, skip: (req) => /^\/overlay\/[^/]+\/events$/.test(req.path),
    });
    registerTipsGauges(metrics.registry, { db, outbox, now });
    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        // Pages frame nothing but the Network's /sso/check; overlays are loaded by OBS, not framed by sites.
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self' 'unsafe-inline' https://openvibe.network", "style-src 'self' 'unsafe-inline' https://openvibe.network",
            "img-src 'self' data: https:", "media-src 'self' https:", "connect-src 'self' https://openvibe.network", "frame-src 'self' https://openvibe.network",
            "frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self' https://openvibe.network https:",
        ].join('; '));
        next();
    });
    app.use(cookieParser());

    app.get('/api/health', (req, res) => res.json({
        ok: true, service: 'tips', version: VERSION, chat_adapter: config.chat.adapter, events: outbox.status(),
    }));
    // Readiness (openvibe-shared/ready): 503 only when the database fails; Network key, Billing and
    // Events are optional and degrade it (see observability.js).
    const readiness = createTipsReadiness({ db, keys, config, outbox, release: release.release, fetchImpl });
    app.get('/api/ready', readiness.handler);
    app.get('/release.json', release.handler);

    const consumer = consumerRouter({ domain, config, log });
    // Service-to-service only: OpenVibe.Events calls 127.0.0.1:4610 directly; anything that came
    // through nginx carries X-Forwarded-For and is refused (the signature is checked as well).
    app.use('/internal', (req, res, next) => (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']
        ? http.sendProblem(res, 404, 'not_found', { ctx: req.ov }) : next()), consumer.router);
    app.use('/api/v1', express.json({ limit: '64kb' }), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, apiAuth.middleware, v1Router({ domain, apiAuth }));
    app.use('/auth', createSessionRoutes(config, userAuth, { fetchImpl }));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'tips', service: 'tips', host: 'openvibe.tips', name: 'OpenVibe.Tips', profile: 'ugc' })); }

    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
    }));
    app.use(createWebRoutes({ domain, config, layout, userAuth }));

    app.use((req, res) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) return http.sendProblem(res, 404, 'not_found', { ctx: req.ov });
        return res.status(404).type('html').send(layout.page({ title: 'Not found', robots: 'noindex', body: pages.errorPage({ status: 404, title: 'Nothing here', message: 'That page does not exist.' }) }));
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        log.error('[Tips] unhandled error:', err);
        if (res.headersSent) return undefined;
        if (req.path.startsWith('/api/')) return http.sendProblem(res, 500, 'tips.internal', { ctx: req.ov });
        return res.status(500).type('html').send(layout.page({ title: 'Error', robots: 'noindex', body: pages.errorPage({ status: 500, title: 'Something went wrong', message: 'This one is on us. Please try again.' }) }));
    });

    Object.assign(app.locals, { config, db, domain, keys, outbox, adapters, billing, consumer, metrics });
    return app;
}

module.exports = { createApp, VERSION };
