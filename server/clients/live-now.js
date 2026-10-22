'use strict';

/**
 * Who is live on OpenVibe.Live right now, for the front page's "Live now" section: Live's public stream list
 * (GET <LIVE_URL>/api/streams, the list its own home shows), read at most once a minute and kept in memory. Only what a
 * card needs is kept: the channel's name, title, category, viewers and start time; never Live's AI text.
 *
 * A slow or failing Live never slows or breaks the page: the call times out after 2 seconds and the last good list (or
 * none) is used. Off in tests unless TIPS_LIVE_NOW=on (config.liveNow).
 */
const TTL_MS = 60_000;
const TIMEOUT_MS = 2_000;
const MAX = 8;

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function createLiveNow({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    let cache = { at: 0, list: [] };
    let inflight = null;

    function shape(rows) {
        return (Array.isArray(rows) ? rows : []).filter((s) => s && (s.is_live === 1 || s.is_live === true) && !s.is_nsfw && /^[A-Za-z0-9_-]{1,40}$/.test(String(s.username || '')))
            .sort((a, b) => (Number(b.viewer_count) || 0) - (Number(a.viewer_count) || 0))
            .slice(0, MAX)
            .map((s) => ({
                username: String(s.username), name: str(s.display_name, 60) || String(s.username), title: str(s.title, 120),
                category: str(s.chosen_category || s.category, 40), viewers: Math.max(0, Number(s.viewer_count) || 0),
                started_at: str(s.started_at, 40), url: `${config.liveUrl}/@${encodeURIComponent(String(s.username))}`,
            }));
    }

    async function refresh() {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const res = await fetchImpl(`${config.liveUrl}/api/streams`, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
            if (!res.ok) throw new Error(`Live answered ${res.status}`);
            const body = await res.json();
            cache = { at: now(), list: shape(body && body.streams) };
        } catch (err) {
            cache = { at: now(), list: cache.list };   // keep the last good list; try again after the TTL
            log.warn(`[Tips] live-now: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
        return cache.list;
    }

    return {
        /** The channels live now, the most watched first (at most eight); [] when Live is off or unreachable. */
        async list() {
            if (!config.liveNow || !config.liveUrl) return [];
            if (now() - cache.at < TTL_MS) return cache.list;
            inflight = inflight || refresh().finally(() => { inflight = null; });
            return await inflight;
        },
    };
}

module.exports = { createLiveNow, TTL_MS };
