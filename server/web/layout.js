'use strict';

/**
 * Page shell for every server-rendered page: full <head> SEO (title, description, canonical,
 * robots, Open Graph), the shared OpenVibe Frame (inline critical canvas + app icon from
 * openvibe-shared, navbar.js from the Network, the SSR footer and a <noscript> navigation), this
 * site's stylesheet and its small progressive script. Everything is useful without JavaScript.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');

const SITE_NAME = 'OpenVibe.Tips';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'Support the creators you watch on OpenVibe: tips, goals, paid messages, text-to-speech and media requests, with stream overlays for creators.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const _hashes = new Map();
function asset(rel) {
    if (!_hashes.has(rel)) {
        let v = 'dev';
        try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing in tests */ }
        _hashes.set(rel, v);
    }
    return `/${rel}?v=${_hashes.get(rel)}`;
}
const assetVersion = (rel) => { asset(rel); return _hashes.get(rel); };

const NAV_LINKS = [
    { label: 'Dashboard', href: '/dashboard' },
    { label: 'Receipts', href: '/receipts' },
];

function createLayout({ config, release }) {
    const abs = (p) => (/^https?:\/\//i.test(p) ? p : `${config.baseUrl}${p.startsWith('/') ? '' : '/'}${p}`);

    /**
     * o: title, description, canonicalPath, robots ('index,follow' | 'noindex,nofollow'), body,
     *    active ('home'|'dashboard'|'receipts'|'creator'), ogImage, jsonLd (array), viewer
     */
    function page(o) {
        const title = o.title ? `${o.title} · ${SITE_NAME}` : `${SITE_NAME} — support the creators you watch`;
        const description = (o.description || DEFAULT_DESCRIPTION).replace(/\s+/g, ' ').trim().slice(0, 300);
        const canonical = abs(o.canonicalPath || '/');
        const robots = o.robots || 'index,follow';
        const nav = {
            service: 'tips', apiBase: NETWORK_URL,
            links: NAV_LINKS.map((l) => ({ ...l, active: o.active === l.label.toLowerCase() })),
            history: { type: 'page', title: o.title || SITE_NAME },
            silentLogin: `${config.baseUrl}/auth/login?silent=1&next={url}`,
            sessionUrl: '/auth/me',
            loginUrl: `/auth/login?next=${encodeURIComponent(o.canonicalPath || '/')}`,
            logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        };
        const footer = { service: 'tips', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
        const jsonLd = (o.jsonLd || []).map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>`).join('\n');
        const who = o.viewer
            ? `<span class="who">Signed in as <b>${esc(o.viewer.name || o.viewer.username || 'you')}</b> · <a href="/auth/logout?next=/">Sign out</a></span>`
            : `<a class="who" href="/auth/login?next=${encodeURIComponent(o.canonicalPath || '/')}">Sign in</a>`;
        return `<!DOCTYPE html>
<html lang="en" data-page="${esc(o.active || 'page')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${esc(robots)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${o.ogType || 'website'}">
<meta property="og:title" content="${esc(o.title || SITE_NAME)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${o.ogImage ? `<meta property="og:image" content="${esc(o.ogImage)}">` : ''}
<meta name="twitter:card" content="summary">
${appIcon.headTags({ site: 'tips' })}
${release ? release.metaTag() : ''}
<script src="${NETWORK_URL}/shared/theme-loader.js" defer></script>
<link rel="stylesheet" href="${asset('css/tips.css')}">
${jsonLd}
<script src="${NETWORK_URL}/shared/navbar.js" defer></script>
<script src="${NETWORK_URL}/shared/footer.js" defer></script>
<script src="${asset('js/tips.js')}" defer></script>
</head>
<body>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: SITE_NAME, home: '/', links: NAV_LINKS })}
<header class="site-head"><a class="brand" href="/">${SITE_NAME}</a><nav>${NAV_LINKS.map((l) => `<a href="${l.href}"${o.active === l.label.toLowerCase() ? ' aria-current="page"' : ''}>${l.label}</a>`).join('')}</nav>${who}</header>
<main id="main" class="page">
${o.body || ''}
${o.canonicalPath === '/' && o.active === 'home' ? frame.shipped({ service: 'tips', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
${frame.footer(footer)}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) { OpenVibeNavbar.init(window.__OV_PAGE.navbar); document.documentElement.classList.add('ov-has-navbar'); } } catch (e) { /* the SSR header stays */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
    }

    return { page, abs };
}

module.exports = { createLayout, esc, asset, assetVersion, SITE_NAME, DEFAULT_DESCRIPTION };
