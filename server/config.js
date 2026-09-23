'use strict';

/**
 * OpenVibe.Tips configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/tips.env in production). loadConfig(env) is pure so tests build their own.
 *
 * Tips never moves money (ADR-012): amounts here are product limits (minimums, message lengths),
 * never prices or rates. Prices and the value of a bit are Billing's.
 */
require('dotenv').config();

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4610);
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.tips' : `http://localhost:${port}`));
    const chatAdapter = String(env.TIPS_CHAT_ADAPTER || (nodeEnv === 'production' ? 'none' : 'test')).toLowerCase();
    return {
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,
        dbPath: env.TIPS_DB_PATH || './data/tips.db',

        // Identity: service tokens and user tokens are RS256 JWTs signed by OpenVibe.Network.
        network: {
            url: networkUrl,
            internalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            issuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
            publicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        },
        audience: env.TIPS_AUDIENCE || 'openvibe.tips',
        // Tips' own client credentials (client `tips` in the Network): service tokens for Billing,
        // Events, Live (chat delivery) and Network (identity resolve for the importer); and the
        // OAuth code flow for browser sign-in (redirect ${baseUrl}/auth/callback).
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'tips',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: env.OV_OAUTH_SCOPE || 'profile',
        },
        cookies: { secure: env.COOKIE_SECURE != null ? bool(env.COOKIE_SECURE) : isProduction },
        // Signs the anti-forgery tokens of the server-rendered forms.
        formSecret: env.TIPS_FORM_SECRET || '',

        billing: {
            url: trim(env.BILLING_URL || 'http://127.0.0.1:4600'),
            audience: env.BILLING_AUDIENCE || 'openvibe.billing',
            // Checkout providers Tips offers (must be enabled on Billing too).
            providers: list(env.TIPS_CHECKOUT_PROVIDERS || 'powerchat'),
            // Billing's minimum purchase; a checkout tip below it is refused here with a clear message.
            minPurchaseBits: int(env.TIPS_MIN_CHECKOUT_BITS, 100),
            retryMs: int(env.TIPS_BILLING_RETRY_MS, 30_000),
            // Billing answers a PowerChat intent with a checkout_ref (pcorder:…) instead of a URL. When
            // set, this template turns it into the link: {ref}, {cents} and {bits} are filled in.
            powerchatLinkTemplate: env.TIPS_POWERCHAT_LINK_TEMPLATE || '',
        },

        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            // Signing secret(s) of Tips' OpenVibe.Events subscription (billing.transaction.*).
            // Comma-separated so a rotation can accept the old and the new value.
            webhookSecrets: list(env.TIPS_EVENTS_SECRET),
        },

        // Chat delivery (paid messages, TTS, media requests, the tip line):
        //   live-chat  OpenVibe.Live's /internal/tips/deliveries (docs/live-patch.diff)
        //   test       recorded here, nothing leaves the process (development, tests)
        //   none       no chat effects are created
        chat: {
            adapter: ['live-chat', 'test', 'none'].includes(chatAdapter) ? chatAdapter : 'none',
            liveUrl: trim(env.LIVE_INTERNAL_URL || 'http://127.0.0.1:3000'),
            liveAudience: env.LIVE_AUDIENCE || 'openvibe.live',
            maxAttempts: int(env.TIPS_DELIVERY_MAX_ATTEMPTS, 6),
            backoffMs: list(env.TIPS_DELIVERY_BACKOFF_MS || '2000,10000,60000,300000,900000').map(Number),
        },

        overlays: {
            // A delivery no overlay received within this window is recorded failed (tips.overlay.failed).
            ttlMs: int(env.TIPS_OVERLAY_TTL_MS, 10 * 60 * 1000),
            heartbeatMs: int(env.TIPS_OVERLAY_HEARTBEAT_MS, 25_000),
            replayLimit: int(env.TIPS_OVERLAY_REPLAY_LIMIT, 50),
            // Open event streams per overlay token: an OBS scene or two, not a leaked link's flood.
            maxStreamsPerToken: int(env.TIPS_OVERLAY_MAX_STREAMS, 10),
        },

        limits: {
            maxBits: int(env.TIPS_MAX_BITS, 10_000_000),         // Billing's maximum
            messageChars: int(env.TIPS_MESSAGE_CHARS, 300),        // Live's donation message limit
            ttsHardCap: int(env.TIPS_TTS_HARD_CAP, 1200),          // Live's hard TTS length cap
            goalTitleChars: 120,                                   // Live's goal title limit
            pendingCheckouts: int(env.TIPS_MAX_PENDING_CHECKOUTS, 20), // unpaid checkouts per supporter per day
        },

        jobs: {
            enabled: env.TIPS_JOBS !== 'off',
            intervalMs: int(env.TIPS_JOBS_INTERVAL_MS, 2000),
        },
        liveUrl: trim(env.LIVE_URL || 'https://openvibe.live'),
        // Media requests Tips accepts (the media queue owner re-checks them).
        mediaHosts: list(env.TIPS_MEDIA_HOSTS || 'youtube.com,www.youtube.com,m.youtube.com,music.youtube.com,youtu.be'),
    };
}

module.exports = { loadConfig };
