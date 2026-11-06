'use strict';

/**
 * OpenVibe.VIP: the gate of the members-only posts (server/domain/posts.js).
 *
 * Two things are asked of VIP:
 *
 *   entitlement(member, creator)  the entitlement answer for that pair (Billing holds the truth,
 *                                 ADR-012; VIP projects it): active only for an active membership.
 *                                 Asked through openvibe-sdk/vip behind the shared product cache, so a
 *                                 "yes" lives at most config.vip.ttlMs and a failure never becomes one.
 *   creator(subject)              the creator's VIP page and their plans: the tiers a post can name and
 *                                 the plan a "Become a member" button points at. A public read.
 *
 * Everything fails closed: no client secret, no VIP, no answer → no membership, no tiers, no join link
 * and no post text.
 */
const { createVipClient, createVipCache } = require('openvibe-sdk/vip');
const { serviceAuth } = require('openvibe-contracts');

const AUDIENCE = 'openvibe.vip';
const SCOPE = 'vip.entitlement.check';

function createVip(config, { fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const enabled = !!(config.vip && config.vip.url && config.oauth && config.oauth.clientSecret);
    const tokenClient = enabled ? serviceAuth.createTokenClient({
        tokenUrl: config.network.internalUrl + '/oauth/token',
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: AUDIENCE,
        scope: SCOPE,
    }) : null;

    const vip = createVipClient({
        baseUrl: config.vip.url,
        tokenClient,
        timeoutMs: config.vip.timeoutMs,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        log,
    });
    const cache = createVipCache({
        vip, ttlMs: config.vip.ttlMs, denyTtlMs: config.vip.denyTtlMs, unavailableTtlMs: config.vip.unavailableTtlMs, now,
    });

    // The creator's VIP page and their plans: cached for a minute (a plan rarely changes).
    const pages = new Map();

    async function creator(subject) {
        const key = String(subject || '');
        if (!key) return null;
        const hit = pages.get(key);
        const t = now();
        if (hit && hit.until > t) return hit.value;
        if (!enabled) { pages.set(key, { until: t + config.vip.plansTtlMs, value: null }); return null; }
        let value = null;
        try {
            const res = await fetchImpl(config.vip.url + '/api/v1/creators/' + encodeURIComponent(key), {
                headers: { Accept: 'application/json', ...(await tokenClient.authHeaders()) },
                signal: AbortSignal.timeout(config.vip.timeoutMs),
            });
            const data = res.ok ? await res.json() : null;
            if (data) {
                const list = Array.isArray(data.plans) ? data.plans : [];
                value = {
                    username: data.creator && data.creator.username ? String(data.creator.username) : null,
                    plans: list.map((p) => ({
                        id: String(p.id),
                        slug: p.slug ? String(p.slug) : null,
                        name: (p.current_version && p.current_version.name) || null,
                        tier: Number(p.tier) || null,
                        purchasable: p.purchasable === true,
                        price_cents: p.price_cents == null ? null : Number(p.price_cents),
                    })),
                };
            }
        } catch (err) {
            log.warn('[Tips] the VIP creator read failed:', err.message);
        }
        pages.set(key, { until: t + config.vip.plansTtlMs, value });
        return value;
    }

    /** The tiers the creator sells (the Billing tiers of their published VIP plans). */
    async function tiers(subject) {
        const c = await creator(subject);
        if (!c) return [];
        return [...new Set(c.plans.map((p) => p.tier).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
    }

    /**
     * The way in: the cheapest plan that reads the post and can be joined. When no tier that reads it
     * can be joined, there is no button — a button that leads nowhere is worse than none.
     */
    async function joinUrl(subject, needed) {
        const c = await creator(subject);
        if (!c || !c.username) return null;
        const min = Array.isArray(needed) && needed.length ? Math.min(...needed) : 1;
        const plan = c.plans.filter((p) => p.purchasable && p.tier && p.tier >= min).sort((a, b) => a.tier - b.tier)[0];
        if (!plan || !plan.slug) return null;
        return config.vip.publicUrl + '/' + encodeURIComponent(c.username) + '#plan-' + encodeURIComponent(plan.slug);
    }

    /** The entitlement answer for member → creator (fail-closed; never throws). */
    async function entitlement({ subject, creator: creatorSubject } = {}) {
        if (!subject || !creatorSubject || subject === creatorSubject) return { active: false, status: 'inactive', reason: 'signed_out' };
        return await cache.entitlement({ subject, creator: creatorSubject, product: 'tips' });
    }

    return { entitlement, creator, tiers, joinUrl, enabled };
}

module.exports = { createVip, AUDIENCE, SCOPE };
