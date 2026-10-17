'use strict';

/**
 * Other ways to support a creator, paid outside OpenVibe (owner 2026-10-08: "our billing system shouldnt be so powerchat
 * dependent… the user can setup powerchat and such on those sites or other platforms… externally"; openvibe-contracts
 * 0.202.0 `support_links`). OpenVibe never sees or holds these payments: the tip page only links to them.
 *
 * A link is a known service plus the creator's handle there, and Tips builds the URL itself. A free-form URL is never
 * stored, so a profile cannot carry a look-alike payment page. A creator may paste their link instead of the handle
 * (https://ko-fi.com/name): the handle is read from it, and only from that service's own host.
 */
const { fail } = require('../util');

const PROVIDERS = {
    kofi: { label: 'Ko-fi', hosts: ['ko-fi.com'], path: /^\/([A-Za-z0-9_]{2,40})\/?$/, handle: /^[A-Za-z0-9_]{2,40}$/, url: (h) => `https://ko-fi.com/${h}` },
    paypal: { label: 'PayPal.me', hosts: ['paypal.me', 'paypal.com'], path: /^\/(?:paypalme\/)?([A-Za-z0-9]{1,20})\/?$/, handle: /^[A-Za-z0-9]{1,20}$/, url: (h) => `https://paypal.me/${h}` },
    patreon: { label: 'Patreon', hosts: ['patreon.com'], path: /^\/(?:c\/)?([A-Za-z0-9_-]{1,64})\/?$/, handle: /^[A-Za-z0-9_-]{1,64}$/, url: (h) => `https://www.patreon.com/${h}` },
    buymeacoffee: { label: 'Buy Me a Coffee', hosts: ['buymeacoffee.com'], path: /^\/([A-Za-z0-9_-]{1,64})\/?$/, handle: /^[A-Za-z0-9_-]{1,64}$/, url: (h) => `https://buymeacoffee.com/${h}` },
    cashapp: { label: 'Cash App', hosts: ['cash.app'], path: /^\/\$([A-Za-z][A-Za-z0-9_-]{0,19})\/?$/, handle: /^[A-Za-z][A-Za-z0-9_-]{0,19}$/, url: (h) => `https://cash.app/$${h}` },
    venmo: { label: 'Venmo', hosts: ['venmo.com', 'account.venmo.com'], path: /^\/(?:u\/)?([A-Za-z0-9_-]{5,30})\/?$/, handle: /^[A-Za-z0-9_-]{5,30}$/, url: (h) => `https://venmo.com/u/${h}` },
    github: { label: 'GitHub Sponsors', hosts: ['github.com'], path: /^\/sponsors\/([A-Za-z0-9-]{1,39})\/?$/, handle: /^[A-Za-z0-9-]{1,39}$/, url: (h) => `https://github.com/sponsors/${h}` },
    liberapay: { label: 'Liberapay', hosts: ['liberapay.com'], path: /^\/([A-Za-z0-9_.-]{1,32})\/?$/, handle: /^[A-Za-z0-9_.-]{1,32}$/, url: (h) => `https://liberapay.com/${h}` },
    opencollective: { label: 'Open Collective', hosts: ['opencollective.com'], path: /^\/([a-z0-9-]{1,64})\/?$/, handle: /^[a-z0-9-]{1,64}$/, url: (h) => `https://opencollective.com/${h}` },
    streamlabs: { label: 'Streamlabs', hosts: ['streamlabs.com'], path: /^\/([A-Za-z0-9_]{1,40})\/tip\/?$/, handle: /^[A-Za-z0-9_]{1,40}$/, url: (h) => `https://streamlabs.com/${h}/tip` },
    streamelements: { label: 'StreamElements', hosts: ['streamelements.com'], path: /^\/([A-Za-z0-9_]{1,40})\/tip\/?$/, handle: /^[A-Za-z0-9_]{1,40}$/, url: (h) => `https://streamelements.com/${h}/tip` },
};
const MAX_LINKS = 8;

/** The handle from what the creator typed: a bare handle (an @ or $ in front is dropped) or their link on that service. */
function handleOf(provider, value) {
    const p = PROVIDERS[provider];
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw) || /^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}\//i.test(raw)) {
        let u;
        try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return undefined; }
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (!p.hosts.includes(host)) return undefined;
        const m = p.path.exec(u.pathname);
        return m ? m[1] : undefined;
    }
    const h = raw.replace(/^[@$]/, '');
    return p.handle.test(h) ? h : undefined;
}

/** A request's support_links → the stored list ([{ provider, handle }], one per provider, in the order given). */
function normalize(input) {
    if (!Array.isArray(input)) fail(422, 'tips.invalid_input', 'support_links must be a list of { provider, handle }');
    const out = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') fail(422, 'tips.invalid_input', 'each support link is { provider, handle }');
        const provider = String(item.provider || '');
        if (!PROVIDERS[provider]) fail(422, 'tips.invalid_input', `support link provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
        const handle = handleOf(provider, item.handle);
        if (handle === null) continue;   // left blank: no link for that service
        if (handle === undefined) fail(422, 'tips.invalid_input', `that is not a ${PROVIDERS[provider].label} name or link`);
        if (out.some((l) => l.provider === provider)) fail(422, 'tips.invalid_input', `one ${PROVIDERS[provider].label} link only`);
        out.push({ provider, handle });
    }
    if (out.length > MAX_LINKS) fail(422, 'tips.invalid_input', `at most ${MAX_LINKS} other ways to support you`);
    return out;
}

/** Stored list → what pages and the API show (unknown or invalid rows are skipped, never shown). */
function present(stored) {
    return (Array.isArray(stored) ? stored : []).map((l) => {
        const p = l && PROVIDERS[l.provider];
        if (!p || !p.handle.test(String(l.handle || ''))) return null;
        return { provider: l.provider, label: p.label, handle: l.handle, url: p.url(l.handle) };
    }).filter(Boolean).slice(0, MAX_LINKS);
}

module.exports = { PROVIDERS, MAX_LINKS, handleOf, normalize, present };
