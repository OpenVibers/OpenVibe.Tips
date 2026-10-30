'use strict';

/**
 * Server-rendered page bodies. Plain HTML forms everywhere: a supporter can tip, and a creator can
 * run the dashboard, with JavaScript switched off. Copy rules: no pricing claims, no pleading copy —
 * the creator's own headline is the only pitch on their page.
 */
const showcase = require('openvibe-shared/showcase');
const { esc } = require('./layout');
const { VOICES } = require('../domain/profiles');
const supportLinks = require('../domain/support-links');
const { pickBlock, pickRules, foldBlock } = require('../render/short');

const n = (v) => Number(v || 0).toLocaleString('en-US');
const when = (s) => (s ? esc(String(s).replace('T', ' ').slice(0, 16)) + ' UTC' : '');
const KIND_LABEL = { tip: 'Tip', paid_message: 'Paid message', tts: 'Text-to-speech', media_request: 'Media request', sound: 'Sound' };
const PAY_LABEL = { pending: 'Payment pending', settled: 'Paid', reversed: 'Reversed', failed: 'Payment failed' };
const DELIVERY_LABEL = { awaiting_payment: 'Waiting for payment', queued: 'Being delivered', delivered: 'Delivered', failed: 'Delivery failed', cancelled: 'Cancelled' };

function hidden(fields) {
    return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
}

/** A goal: full (the dashboard) or its public shape (amounts null when the creator hides them). */
function goalCard(g) {
    const amounts = g.current_amount != null;
    const bar = amounts ? `aria-valuemin="0" aria-valuemax="${g.target_amount}" aria-valuenow="${g.current_amount}"` : `aria-valuemin="0" aria-valuemax="100" aria-valuenow="${g.percent}"`;
    const supporters = Array.isArray(g.supporters) && g.supporters.length
        ? `<ul class="supporters">${g.supporters.map((x) => `<li>${esc(x.name)}${x.amount != null ? ` <small>${n(x.amount)} Vibes</small>` : ''}</li>`).join('')}</ul>` : '';
    return `<article class="goal${g.reached ? ' reached' : ''}">
  <h3>${esc(g.title)}</h3>
  ${g.description ? `<p>${esc(g.description)}</p>` : ''}
  <div class="bar" role="progressbar" ${bar}><span style="width:${g.percent}%"></span></div>
  <p class="meta">${amounts ? `${n(g.current_amount)} of ${n(g.target_amount)} Vibes · ` : ''}${g.percent}%${g.reached ? ' · reached' : ''}${g.status === 'closed' ? ' · closed' : ''}</p>
  ${supporters}
</article>`;
}

function errorBox(msg) { return msg ? `<p class="notice error" role="alert">${esc(msg)}</p>` : ''; }

/**
 * What a new tip page asks for until its creator changes it: migrations/0001_initial.sql's column defaults
 * (creator_tip_profiles.min_amount, paid_message_min, tts_min_amount, media_request_min; sound_min in 0005). test/pages.test.js reads
 * the migration and fails if these drift, so the home page never quotes a number the service does not use.
 */
const NEW_PAGE_MINIMUMS = Object.freeze({ tip: 1, paid_message: 100, tts: 100, media_request: 25, sound: 50 });
const vibes = (n) => `${n} ${n === 1 ? 'Vibe' : 'Vibes'}`;

/** Questions people ask, answered from how Tips works (also the home's FAQPage JSON-LD). */
const HOME_FAQ = Object.freeze([
    { q: 'What are Vibes?', a: 'Vibes are OpenVibe\'s credits for supporting creators. Your balance is kept by OpenVibe.Billing, and the same Vibes work for tips here and on OpenVibe.Live.' },
    { q: 'How do I pay?', a: 'From your Vibes balance, or through a checkout on the creator\'s page. OpenVibe.Billing handles every payment, and your receipt at openvibe.tips/receipts shows when it settled and when your message was delivered.' },
    { q: 'Can I stay anonymous?', a: 'Yes. For each tip you can show your name as "Anonymous" to everyone but yourself, hide the amount from the public, or keep a tip\'s message for the creator only.' },
    { q: 'Can creators on Twitch, YouTube or Kick use it?', a: 'Yes. The alerts and goal bar are web pages a creator adds to OBS or Streamlabs as a browser source, so they show on any stream. Paid messages also appear in the creator\'s OpenVibe chat.' },
    { q: 'What can a creator control?', a: 'Their own minimums, whether text-to-speech, media requests and sounds are on, how long a media request may run, a word filter that stars out or holds messages, and moderators who can hide anything that slips through.' },
    { q: 'Do I need an account?', a: 'Anyone can read a creator\'s page. Sending something needs an OpenVibe account, so your receipts and your privacy choices stay with you.' },
]);

const SUPPORT_SERVICES = Object.freeze(['Ko-fi', 'PayPal.me', 'Patreon', 'Buy Me a Coffee', 'Cash App', 'Venmo', 'GitHub Sponsors', 'Liberapay', 'Open Collective', 'Streamlabs', 'StreamElements']);

const watching = (v) => (v === 1 ? '1 watching' : `${n(v)} watching`);

/** A titled home section with an optional "see all" link; nothing when it has no body. */
function homeSection({ id, title, lede, more, body, headId }) {
    if (!body) return '';
    const h = headId || id;
    return `<section class="tp-sec" aria-labelledby="${esc(h)}"><div class="tp-head"><h2 id="${esc(h)}">${esc(title)}</h2>${more ? `<a class="tp-more" href="${esc(more.href)}">${esc(more.label)}<span aria-hidden="true"> →</span></a>` : ''}</div>${lede ? `<p class="tp-lede">${esc(lede)}</p>` : ''}${body}</section>`;
}

/** The home's pick block, one part at a time on a phone: the ids of its panes, in order. */
const HOME_PANE_IDS = ['send', 'for-creators', 'services', 'how', 'costs'];

/**
 * The home: what Tips is for, who is live on OpenVibe right now, the creators who switched their page on, what a
 * supporter can send, what a creator gets (overlays for any streaming app, other ways to be paid), what it costs, how it
 * works and the questions people ask. live: clients/live-now.js; creators: switched-on pages with their active goal.
 */
function home({ creators, live = [] }) {
    const m = NEW_PAGE_MINIMUMS;
    const liveCards = live.length ? `<ul class="tp-cards">${live.map((c) => `<li class="tp-card"><p class="tp-card-top"><span class="tp-live">Live</span> <a href="${esc(c.url)}"><strong>${esc(c.name)}</strong></a></p>${c.title ? `<p>${esc(c.title)}</p>` : ''}<p class="meta">${[c.category, watching(c.viewers)].filter(Boolean).map(esc).join(' · ')}</p></li>`).join('')}</ul>` : '';
    const creatorCards = creators.length ? `<ul class="tp-cards">${creators.map((c) => `<li class="tp-card"><p class="tp-card-top">${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" width="40" height="40" loading="lazy">` : ''}<a href="/${esc(c.handle)}"><strong>${esc(c.display_name)}</strong></a></p>${c.headline ? `<p>${esc(c.headline)}</p>` : ''}${c.goal ? `<p class="meta">Goal: ${esc(c.goal.title)}</p><div class="bar" role="progressbar" aria-label="${esc(c.goal.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.goal.percent}"><span style="width:${c.goal.percent}%"></span></div>` : ''}</li>`).join('')}</ul>` : '';
    return showcase.hero({
        eyebrow: 'OpenVibe.Tips',
        title: 'Support the creators', accent: 'you watch',
        lede: 'Tip a creator with Vibes, send a highlighted paid message, have your message read out, request a video or play one of their sounds on stream. Creators set goals and show every tip with overlays that work on any streaming app.',
        actions: [
            ...(creators.length ? [{ label: 'Find a creator', href: '#creators', primary: true }] : live.length ? [{ label: 'See who is live', href: '#live', primary: true }] : []),
            { label: 'Start your tip page', href: '/dashboard', primary: !creators.length && !live.length },
            { label: 'Your receipts', href: '/receipts' },
        ],
    }) + homeSection({ id: 'live', title: 'Live on OpenVibe now', lede: 'Open a channel to watch, chat and support the creator.', more: { href: 'https://openvibe.live/', label: 'Everyone live' }, body: liveCards })
    + homeSection({ id: 'creators', title: 'Creators on OpenVibe.Tips', lede: 'Every creator who switched their tip page on, the most recently updated first.', body: creatorCards })
    + pickBlock({ key: 'parts', label: 'What Tips does', head: 'What Tips does', panes: [
        { id: 'send', label: 'What you can send', html: showcase.features({
        title: 'What you can send',
        items: [
            { icon: 'ov:tips', title: 'A tip', text: 'Vibes straight to the creator, with an optional message.' },
            { icon: 'ov:chat', title: 'A paid message', text: 'Your message, highlighted in their chat.' },
            { icon: 'ov:audio', title: 'Text-to-speech', text: 'Your message read out on stream, where the creator turned it on.' },
            { icon: 'ov:video', title: 'A media request', text: 'A video for their stream, up to the length they allow, where they turned it on.' },
            { icon: 'ov:audio', title: 'A sound', text: "One of the creator's sounds, played on stream by their overlay, where they turned it on." },
            { icon: 'ov:shield', title: 'Your privacy, your choice', text: 'Send as Anonymous, hide the amount, or keep a message for the creator only.' },
        ],
    }) },
        { id: 'for-creators', label: 'For creators', html: showcase.features({
        title: 'For creators',
        lede: 'A tip page at openvibe.tips/your-name, set up from your dashboard in a few minutes.',
        items: [
            { icon: 'ov:live', title: 'Overlays for any stream', text: 'Alerts and a goal bar as browser sources for OBS or Streamlabs, on Twitch, YouTube, Kick or OpenVibe.Live.', href: '/dashboard' },
            { icon: 'ov:check', title: 'Goals', text: 'Set goals with a target; every tip moves the bar on your page and on stream.', href: '/dashboard' },
            { icon: 'ov:audio', title: 'Sounds and requests', text: 'Upload up to 12 sounds, turn on text-to-speech and media requests, and set your own minimums.', href: '/dashboard' },
            { icon: 'ov:shield', title: 'Moderation', text: 'A word filter that stars out or holds messages, and moderators who can hide anything that slips through.', href: '/dashboard' },
            { icon: 'ov:tips', title: 'Other ways to be paid', text: `Link your ${SUPPORT_SERVICES.slice(0, 4).join(', ')} and ${SUPPORT_SERVICES.length - 4} more services beside your tip form.`, href: '/dashboard' },
            { icon: 'ov:docs', title: 'Receipts both ways', text: 'Supporters keep a receipt for every tip; you see each one settle and reach your stream.' },
        ],
    }) },
        { id: 'services', label: 'Other ways', html: homeSection({ id: 'services', headId: 'services-h', title: 'Other ways to support', lede: 'A creator can list these beside their tip form. Each link is built from the creator\'s handle on that service\'s own site, and it is paid there, outside OpenVibe.', body: `<ul class="tp-chips">${SUPPORT_SERVICES.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` }) },
        { id: 'how', label: 'How it works', html: showcase.steps({
        title: 'How it works',
        items: [
            { title: 'Pick a creator', text: 'Every creator who switched their page on has one at openvibe.tips/name, linked from their channel.' },
            { title: 'Choose what to send', text: "A tip, a paid message, text-to-speech, a media request or a sound, within the creator's own limits." },
            { title: 'Pay with Vibes', text: 'From your Vibes balance, or through checkout. Payments are handled by OpenVibe.Billing; your receipt shows when the payment settled and when your message was delivered.' },
        ],
    }) },
        { id: 'costs', label: 'What it costs', html: showcase.pricing({
        title: 'What it costs to send',
        lede: 'The least you can send of each. Every creator sets their own minimums; these are what a new page starts with.',
        tiers: [
            { name: 'Tip', price: vibes(m.tip), items: ['Any amount above the minimum', 'Counts toward their goals'] },
            { name: 'Paid message', price: vibes(m.paid_message), items: ['Highlighted in chat', 'Shown by their stream overlay'] },
            { name: 'Text-to-speech', price: vibes(m.tts), items: ['Read out on stream', 'Only where the creator turned it on'] },
            { name: 'Media request', price: vibes(m.media_request), items: ['A video for their stream', 'Only where the creator turned it on'] },
            { name: 'Sound', price: vibes(m.sound), items: ['Played on stream by their overlay', 'Only where the creator turned it on'] },
        ],
        note: "The creator's page shows their own minimums before you pay.",
    }) },
    ] }) + foldBlock({
        id: 'faq',
        head: '<h2 id="faq-h">Questions and answers</h2>',
        html: `<section class="tp-sec" aria-labelledby="faq-h"><div class="tp-head"><h2>Questions and answers</h2></div><div class="tp-faq">${HOME_FAQ.map((x) => `<details><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join('')}</div></section>`,
    }) + foldBlock({
        id: 'network',
        head: '<h2 id="network-h">Part of OpenVibe</h2>',
        html: showcase.network({ service: 'tips' }),
    }) + showcase.cta({ title: 'Stream? Get tipped anywhere.', text: 'Start a tip page, add the overlay to your streaming app and share your link.', actions: [{ label: 'Start your tip page', href: '/dashboard', primary: true }, { label: 'Memberships on OpenVibe.VIP', href: 'https://openvibe.vip/' }] });
}

/** The tip form: every field works as a plain POST. */
function tipForm({ profile, goals, viewer, csrf, idem, values = {}, providers, error, sounds = [] }) {
    const kinds = [['tip', 'Tip', profile.min_amount]];
    kinds.push(['paid_message', 'Paid message (highlighted in chat)', Math.max(profile.min_amount, profile.paid_message_min)]);
    if (profile.tts_enabled) kinds.push(['tts', 'Text-to-speech (read out on stream)', Math.max(profile.min_amount, profile.tts_min_amount)]);
    if (profile.media_requests_enabled) kinds.push(['media_request', 'Media request', Math.max(profile.min_amount, profile.media_request_min)]);
    const soundsOn = profile.sounds_enabled && sounds.length > 0;
    if (soundsOn) kinds.push(['sound', 'A sound (played on stream)', Math.max(profile.min_amount, Number(profile.sound_min))]);
    const kind = values.kind || 'tip';
    const active = goals.filter((g) => g.status === 'active');
    if (!profile.accepting) return `<section class="card"><p>${esc(profile.display_name)} is not accepting tips right now.</p></section>`;
    return `<form class="card tip-form" method="post" action="/${esc(profile.handle)}/tip">
  <h2>Send ${esc(profile.display_name)} something</h2>
  ${errorBox(error)}
  ${hidden({ csrf: csrf || '', idem })}
  <fieldset class="kinds"><legend>What to send</legend>
    ${kinds.map(([k, label, min]) => `<label><input type="radio" name="kind" value="${k}"${k === kind ? ' checked' : ''}> ${esc(label)} <small>from ${n(min)} Vibes</small></label>`).join('\n    ')}
  </fieldset>
  <label>Amount (Vibes) <input type="number" name="amount" min="1" max="10000000" step="1" required value="${esc(values.amount || '')}" inputmode="numeric"></label>
  <label>Message <small>(optional for a tip, up to 300 characters)</small><textarea name="message" maxlength="300" rows="3">${esc(values.message || '')}</textarea></label>
  ${profile.tts_enabled ? `<div class="when-tts"><label>Text to read out <small>(up to ${profile.tts_max_chars} characters; the message is used when empty)</small><textarea name="tts_text" maxlength="${profile.tts_max_chars}" rows="2">${esc(values.tts_text || '')}</textarea></label>
  <label>Voice <select name="tts_voice">${VOICES.map((v) => `<option${v === (values.tts_voice || profile.tts_voice) ? ' selected' : ''}>${v}</option>`).join('')}</select></label></div>` : ''}
  ${profile.media_requests_enabled ? `<label class="when-media">Media link <small>(YouTube, up to ${Math.floor(profile.media_max_seconds / 60)} minutes)</small><input type="url" name="media_url" value="${esc(values.media_url || '')}" placeholder="https://www.youtube.com/watch?v=…"></label>` : ''}
  ${soundsOn ? `<fieldset class="when-sound sounds"><legend>Which sound</legend>
    ${sounds.map((x, i) => `<label class="sound-pick"><input type="radio" name="sound_id" value="${esc(x.id)}"${(values.sound_id ? values.sound_id === x.id : i === 0) ? ' checked' : ''}> ${esc(x.name)} <audio controls preload="none" src="${esc(x.url)}"></audio></label>`).join('\n    ')}
  </fieldset>` : ''}
  ${active.length ? `<label>Count toward <select name="goal_id">${active.length > 1 ? '<option value="">No goal</option>' : ''}${active.map((g) => `<option value="${esc(g.id)}"${values.goal_id === g.id ? ' selected' : ''}>${esc(g.title)}</option>`).join('')}</select></label>` : ''}
  <fieldset class="pay"><legend>Pay with</legend>
    <label><input type="radio" name="pay_with" value="credit"${values.pay_with !== 'checkout' ? ' checked' : ''}> My Vibes balance</label>
    ${providers.length ? `<label><input type="radio" name="pay_with" value="checkout"${values.pay_with === 'checkout' ? ' checked' : ''}> Checkout (${providers.map(esc).join(', ')}) <small>buys exactly these Vibes and gives them</small></label>` : ''}
  </fieldset>
  <label>Show my name as <input type="text" name="supporter_name" maxlength="80" value="${esc(values.supporter_name || (viewer ? viewer.name || viewer.username || '' : ''))}"></label>
  <fieldset class="privacy"><legend>Privacy</legend>
    <label><input type="checkbox" name="anonymous" value="1"${values.anonymous ? ' checked' : ''}> Send anonymously <small>(everyone, ${esc(profile.display_name)} included, sees "Anonymous")</small></label>
    <label><input type="checkbox" name="hide_amount" value="1"${values.hide_amount ? ' checked' : ''}> Hide the amount <small>(${esc(profile.display_name)} still sees it; a goal bar still moves by it)</small></label>
    <label class="when-tip"><input type="checkbox" name="private_message" value="1"${values.private_message ? ' checked' : ''}> Keep my message private <small>(a tip only: ${esc(profile.display_name)} reads it, it is not shown on stream or on this site)</small></label>
  </fieldset>
  <button type="submit" class="btn">${viewer ? 'Send' : 'Sign in to send'}</button>
  <p class="fine">Tips are final once paid. Your receipt shows the payment and delivery status separately. You can download or erase your tips data from your <a href="/receipts">receipts</a>.</p>
</form>`;
}

/** Other ways to support, paid outside OpenVibe (domain/support-links.js builds every link; none is user-written). */
function supportLinksSection(profile) {
    const links = supportLinks.present(profile.support_links);
    if (!links.length) return '';
    return `<section class="card support-links"><h2>Other ways to support ${esc(profile.display_name)}</h2>
  <ul class="support-list">${links.map((l) => `<li><a class="btn ghost" href="${esc(l.url)}" rel="nofollow noopener ugc" target="_blank">${esc(l.label)}</a></li>`).join('')}</ul>
  <p class="fine">These are paid outside OpenVibe: OpenVibe never sees or holds them, and they do not count toward goals.</p>
</section>`;
}

function creatorPage({ profile, goals, viewer, csrf, idem, values, providers, error, ownerPreview, sounds = [] }) {
    const active = goals.filter((g) => g.status === 'active');
    return `${ownerPreview ? '<p class="notice">Your page is switched off: only you can see it, and search engines are told not to index it. Switch it on in the <a href="/dashboard">dashboard</a>.</p>' : ''}
<section class="creator-head">
  ${profile.avatar_url ? `<img class="avatar" src="${esc(profile.avatar_url)}" alt="" width="96" height="96">` : ''}
  <div><h1>${esc(profile.display_name)}</h1>${profile.headline ? `<p class="headline">${esc(profile.headline)}</p>` : ''}
  <p class="links"><a href="https://openvibe.live/@${esc(profile.handle)}">Watch on OpenVibe.Live</a> · <a href="/${esc(profile.handle)}/goals">Goals</a>${profile.page.supporters_page ? ` · <a href="/${esc(profile.handle)}/supporters">Supporters</a>` : ''}</p></div>
</section>
${active.length ? `<section><h2>Goals</h2>${active.map(goalCard).join('')}</section>` : ''}
${tipForm({ profile, goals, viewer, csrf, idem, values, providers, error, sounds })}
${supportLinksSection(profile)}`;
}

function goalsPage({ profile, goals }) {
    return `<h1>${esc(profile.display_name)} — goals</h1>
<p><a href="/${esc(profile.handle)}">Back to ${esc(profile.display_name)}</a></p>
${goals.length ? goals.map(goalCard).join('') : '<p>No goals yet.</p>'}
<p class="fine">Goal totals count settled payments only.${profile.page.goal_supporters ? ' Supporters are listed as they chose to be shown.' : ''}</p>`;
}

/** openvibe.tips/<handle>/supporters: what the creator chose to show, as each supporter allowed. */
function supportersPage({ profile, leaderboard, recent }) {
    const page = profile.page;
    const board = leaderboard.length
        ? `<ol class="leaderboard">${leaderboard.map((r) => `<li><span>${esc(r.name)}</span>${r.total != null ? ` <small>${n(r.total)} Vibes</small>` : ''}</li>`).join('')}</ol>`
        : '<p>No supporters to show yet.</p>';
    const wall = recent && recent.length
        ? `<section><h2>Recent messages</h2><ul class="wall">${recent.map((v) => `<li><b>${esc(v.supporter_name)}</b>${v.amount != null ? ` <small>${n(v.amount)} Vibes</small>` : ''}<p>${esc(v.message)}</p><small>${when(v.at)}</small></li>`).join('')}</ul></section>` : '';
    return `<h1>${esc(profile.display_name)} — supporters</h1>
<p><a href="/${esc(profile.handle)}">Back to ${esc(profile.display_name)}</a></p>
<section><h2>Top supporters</h2>${board}</section>
${page.supporters_messages ? wall || '<p>No public messages yet.</p>' : ''}
<p class="fine">Anonymous tips and tips with a hidden amount are not on this list.</p>`;
}

function receiptRow(i, as) {
    const who = as === 'creator' ? esc(i.supporter_name || 'Someone') : `<a href="/${esc(i.creator_handle || '')}">${esc(i.creator_name || 'creator')}</a>`;
    return `<tr${i.test ? ' class="test"' : ''}><td><a href="/receipts/${esc(i.id)}">${when(i.created_at)}</a></td><td>${who}</td><td>${esc(KIND_LABEL[i.kind])}${i.test ? ' <small>(simulation)</small>' : ''}</td><td class="num">${n(i.amount)}</td><td>${esc(PAY_LABEL[i.payment.state])}</td><td>${esc(DELIVERY_LABEL[i.delivery.state])}</td></tr>`;
}

function privacyLine(p) {
    if (!p) return '';
    const parts = [p.anonymous && 'sent anonymously', p.hide_amount && 'amount hidden', p.private_message && 'message private'].filter(Boolean);
    return parts.length ? esc(parts.join(' · ')) : '';
}

function receiptsPage({ rows, next, flash }) {
    return `<h1>Your receipts</h1>
${flash ? `<p class="notice">${esc(flash)}</p>` : ''}
${rows.length ? `<table class="list"><thead><tr><th>When</th><th>Creator</th><th>What</th><th class="num">Vibes</th><th>Payment</th><th>Delivery</th></tr></thead><tbody>${rows.map((r) => receiptRow(r, 'supporter')).join('')}</tbody></table>` : '<p>No tips yet.</p>'}
${next ? `<p><a href="/receipts?cursor=${esc(next)}">Older</a></p>` : ''}
<section class="card"><h2>Your data</h2>
  <p><a class="btn ghost" href="/receipts/export">Download your tips (JSON)</a></p>
  <p><a href="/receipts/erase">Erase your data from your tips</a> <small>— your name and messages are removed; the payment record stays with the amount, because Billing's books and the creators' totals must add up.</small></p>
</section>`;
}

function erasePage({ csrf, idem, pending, count }) {
    return `<h1>Erase your data from your tips</h1>
<section class="card">
  <p>This removes you from the ${n(count)} tip${count === 1 ? '' : 's'} you sent on OpenVibe.Tips: your account, the name you showed, your messages, text-to-speech text and media links. They then read "Anonymous" everywhere, including overlays, and you no longer see them in your receipts. It cannot be undone.</p>
  <p>What stays: the amount, the creator, the date and the OpenVibe.Billing reference of each payment, because Billing's books and the creators' totals must still add up. Billing keeps its own payment records; ask Billing about those.</p>
  ${pending ? `<p class="notice">${n(pending)} tip${pending === 1 ? ' is' : 's are'} still waiting for payment and will be kept until the payment settles or fails; erase again afterwards.</p>` : ''}
  <form method="post" action="/receipts/erase">${hidden({ csrf, idem })}
    <label><input type="checkbox" name="confirm" value="1" required> I understand this cannot be undone</label>
    <button class="btn" type="submit">Erase my data</button>
  </form>
</section>`;
}

function receiptPage({ i, profile, as, cancelled }) {
    const checkoutOpen = i.payment.state === 'pending' && i.checkout && i.checkout.url && as === 'supporter';
    return `<h1>Receipt</h1>
${cancelled && i.payment.state === 'pending' ? '<p class="notice">Checkout was cancelled. Nothing was charged; you can start again from the creator\'s page.</p>' : ''}
<dl class="receipt">
  <dt>Creator</dt><dd>${profile ? `<a href="/${esc(profile.handle)}">${esc(profile.display_name)}</a>` : 'unknown'}</dd>
  <dt>From</dt><dd>${esc(i.supporter_name || 'Someone')}</dd>
  <dt>What</dt><dd>${esc(KIND_LABEL[i.kind])}${i.test ? ' (simulation, not charged, not counted)' : ''}</dd>
  ${privacyLine(i.privacy) ? `<dt>Privacy</dt><dd>${privacyLine(i.privacy)}</dd>` : ''}
  ${i.moderation && i.moderation.state !== 'visible' ? `<dt>Moderation</dt><dd>${esc(MOD_LABEL[i.moderation.state])} by the creator's moderation; the payment is not affected</dd>` : ''}
  <dt>Amount</dt><dd>${n(i.amount)} Vibes</dd>
  ${i.message ? `<dt>Message</dt><dd>${esc(i.message)}</dd>` : ''}
  ${i.tts ? `<dt>Read out</dt><dd>${esc(i.tts.text)} <small>(${esc(i.tts.voice)})</small></dd>` : ''}
  ${i.media ? `<dt>Media</dt><dd>${esc(i.media.url)}</dd>` : ''}
  <dt>Payment</dt><dd>${esc(PAY_LABEL[i.payment.state])}${i.payment.settled_at ? ` · ${when(i.payment.settled_at)}` : ''}${i.payment.failure ? ` · ${esc(i.payment.failure)}` : ''}</dd>
  <dt>Delivery</dt><dd>${esc(DELIVERY_LABEL[i.delivery.state])}${i.delivery.delivered_at ? ` · ${when(i.delivery.delivered_at)}` : ''}</dd>
  ${i.payment.billing_txn_id ? `<dt>Billing reference</dt><dd><code>${esc(i.payment.billing_txn_id)}</code></dd>` : ''}
  <dt>Receipt id</dt><dd><code>${esc(i.id)}</code></dd>
</dl>
${checkoutOpen ? `<p><a class="btn" href="${esc(i.checkout.url)}" rel="noopener">Continue to checkout</a></p>` : ''}
${i.payment.state === 'pending' && i.funding === 'checkout' && !i.checkout?.url ? '<p class="notice">This checkout has no payment link yet. Nothing is charged until the payment completes.</p>' : ''}
<p class="fine">The payment state comes from OpenVibe.Billing. Delivery is tracked separately: a delivery problem never undoes a payment.</p>`;
}

/** The dashboard's paid sounds: the list (with a player and a delete button) and the upload form (a plain multipart POST). */
function soundsCard({ profile: p, sounds, csrf, idem }) {
    const full = sounds.length >= 12;
    return `<section class="card" id="sounds"><h2>Paid sounds</h2>
  <p>Supporters pay to play one of these on stream; your overlay plays it with the alert${p.sounds_enabled ? '' : '. <b>Paid sounds are off</b>: switch them on in Your page above'}. MP3, OGG or WAV, up to 512 KB each, 12 at most.</p>
  ${sounds.length ? `<ul class="sound-list">${sounds.map((x) => `<li><span class="sound-name">${esc(x.name)}</span> <audio controls preload="none" src="${esc(x.url)}"></audio>
    <form method="post" action="/dashboard/sounds/${esc(x.id)}/delete">${hidden({ csrf, idem: `${idem}-sd-${x.id}` })}<button class="btn btn-small" type="submit">Delete</button></form></li>`).join('')}</ul>` : '<p class="muted">No sounds yet.</p>'}
  ${full ? '<p class="muted">You have 12 sounds: delete one to add another.</p>' : `<form method="post" action="/dashboard/sounds" enctype="multipart/form-data" class="sound-upload">${hidden({ csrf, idem: `${idem}-su` })}
    <label>Name <input type="text" name="name" maxlength="40" placeholder="Airhorn"></label>
    <label>File <input type="file" name="file" accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav" required></label>
    <button class="btn" type="submit">Add sound</button>
  </form>`}
</section>`;
}

/** The dashboard's other ways to support: one field per known service (a name, or the creator's link there). */
function supportLinksCard({ profile: p, csrf, idem }) {
    const have = new Map(supportLinks.present(p.support_links).map((l) => [l.provider, l.handle]));
    const hint = { kofi: 'ko-fi.com/…', paypal: 'paypal.me/…', patreon: 'patreon.com/…', buymeacoffee: 'buymeacoffee.com/…', cashapp: 'cash.app/$…', venmo: 'venmo.com/u/…', github: 'github.com/sponsors/…', liberapay: 'liberapay.com/…', opencollective: 'opencollective.com/…', streamlabs: 'streamlabs.com/…/tip', streamelements: 'streamelements.com/…/tip' };
    return `<section class="card" id="support-links"><h2>Other ways to support you</h2>
  <p>Your tip page can link to where else people pay you. Type your name on each service you use, or paste your link there; leave the rest blank. Up to ${supportLinks.MAX_LINKS}. These payments happen outside OpenVibe and do not count toward goals.</p>
  <form method="post" action="/dashboard/support-links" class="support-form">${hidden({ csrf, idem: `${idem}-sl` })}
    ${Object.entries(supportLinks.PROVIDERS).map(([k, v]) => `<label>${esc(v.label)} <input type="text" name="link_${k}" maxlength="200" autocomplete="off" spellcheck="false" placeholder="${esc(hint[k] || '')}" value="${esc(have.get(k) || '')}"></label>`).join('\n    ')}
    <button class="btn" type="submit">Save links</button>
  </form>
</section>`;
}

function dashboard({ profile, goals, tokens, configs, totals, recent, deliveries, csrf, idem, flash, error, connected, chatAdapter, mod = {}, sounds = [] }) {
    const p = profile;
    const f = (k) => (p[k] ? ' checked' : '');
    const alertCfg = configs.find((c) => c.kind === 'alerts');
    const s = alertCfg ? alertCfg.settings : {};
    return `<h1>Creator dashboard</h1>
${flash ? `<p class="notice">${esc(flash)}</p>` : ''}${errorBox(error)}
<section class="grid">
  <div class="card"><h2>Totals</h2>
    <p class="big">${n(totals.settled_via_billing)} <small>Vibes settled through Billing</small></p>
    <p>${n(totals.external)} Vibes-equivalent tipped on your own PowerChat · ${n(totals.interactions)} tips · ${n(totals.pending)} pending</p>
    <p class="fine">Simulations (${n(totals.simulations)}) are never counted. OpenVibe.Billing keeps your Vibes: your balance and cash-outs are in <a href="https://openvibe.live/#vibes">your Vibes</a>.</p>
  </div>
  <div class="card"><h2>Your page</h2>
    <p><a href="/${esc(p.handle)}">openvibe.tips/${esc(p.handle)}</a> — ${p.page_enabled ? 'on and indexable' : 'off (only you can see it)'}</p>
    <form method="post" action="/dashboard/profile">${hidden({ csrf, idem: `${idem}-p` })}
      <label><input type="checkbox" name="page_enabled" value="1"${f('page_enabled')}> Public page on (search engines may index it)</label>
      <label><input type="checkbox" name="accepting" value="1"${f('accepting')}> Accepting tips</label>
      <label>Headline <input type="text" name="headline" maxlength="280" value="${esc(p.headline || '')}"></label>
      <label>Minimum tip <input type="number" name="min_amount" min="1" value="${p.min_amount}"></label>
      <label>Minimum paid message <input type="number" name="paid_message_min" min="1" value="${p.paid_message_min}"></label>
      <label><input type="checkbox" name="tts_enabled" value="1"${f('tts_enabled')}> Text-to-speech</label>
      <label>Minimum for text-to-speech <input type="number" name="tts_min_amount" min="1" value="${p.tts_min_amount}"></label>
      <label>Text-to-speech length <input type="number" name="tts_max_chars" min="20" max="1200" value="${p.tts_max_chars}"></label>
      <label>Default voice <select name="tts_voice">${VOICES.map((v) => `<option${v === p.tts_voice ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label><input type="checkbox" name="media_requests_enabled" value="1"${f('media_requests_enabled')}> Media requests</label>
      <label>Minimum media request <input type="number" name="media_request_min" min="1" value="${p.media_request_min}"></label>
      <label>Longest media (seconds) <input type="number" name="media_max_seconds" min="10" max="10800" value="${p.media_max_seconds}"></label>
      <label><input type="checkbox" name="sounds_enabled" value="1"${f('sounds_enabled')}> Paid sounds <small>(your sounds, below, played by your overlay)</small></label>
      <label>Minimum for a sound <input type="number" name="sound_min" min="1" value="${p.sound_min}"></label>
      <fieldset><legend>Public pages</legend>
        <label><input type="checkbox" name="page_goal_amounts" value="1"${p.page.goal_amounts ? ' checked' : ''}> Goals show their amounts <small>(off: the percentage only)</small></label>
        <label><input type="checkbox" name="page_goal_supporters" value="1"${p.page.goal_supporters ? ' checked' : ''}> Goals list their latest supporters</label>
        <label><input type="checkbox" name="page_supporters_page" value="1"${p.page.supporters_page ? ' checked' : ''}> A supporters page with your top supporters</label>
        <label><input type="checkbox" name="page_supporters_amounts" value="1"${p.page.supporters_amounts ? ' checked' : ''}> Show amounts on the supporters page</label>
        <label><input type="checkbox" name="page_supporters_messages" value="1"${p.page.supporters_messages ? ' checked' : ''}> Show recent public messages on the supporters page</label>
        <p class="fine">Each supporter's own choice comes first: anonymous tips read "Anonymous", hidden amounts and private messages are never shown.</p>
      </fieldset>
      <input type="hidden" name="revision" value="${p.revision}">
      <button class="btn" type="submit">Save</button>
    </form>
  </div>
</section>
${soundsCard({ profile: p, sounds, csrf, idem })}
${supportLinksCard({ profile: p, csrf, idem })}
<section class="card"><h2>Goals</h2>
  ${goals.length ? goals.map((g) => `${goalCard(g)}${g.status === 'active' ? `<form class="inline" method="post" action="/dashboard/goals/${esc(g.id)}">${hidden({ csrf, idem: `${idem}-g-${g.id}`, revision: g.revision })}
    <label>Title <input name="title" maxlength="120" value="${esc(g.title)}"></label><label>Target <input type="number" name="target_amount" min="1" value="${g.target_amount}"></label>
    <button class="btn ghost" type="submit">Update</button></form>
    <form class="inline" method="post" action="/dashboard/goals/${esc(g.id)}/close">${hidden({ csrf, idem: `${idem}-c-${g.id}` })}<button class="btn ghost" type="submit">Close goal</button></form>` : ''}`).join('') : '<p>No goals yet.</p>'}
  <form method="post" action="/dashboard/goals">${hidden({ csrf, idem: `${idem}-ng` })}
    <h3>New goal</h3>
    <label>Title <input name="title" maxlength="120" required></label>
    <label>Target (Vibes) <input type="number" name="target_amount" min="1" required></label>
    <label>Description <input name="description" maxlength="1000"></label>
    <button class="btn" type="submit">Add goal</button>
  </form>
</section>
<section class="card"><h2>Overlays</h2>
  <p>Add an overlay to OBS as a Browser Source. Each overlay link carries its own token: it shows alerts and goals, nothing else, and you can revoke it at any time. ${connected ? `<b>${connected}</b> overlay${connected === 1 ? '' : 's'} connected now.` : 'No overlay is connected right now.'}</p>
  ${tokens.length ? `<table class="list"><thead><tr><th>Label</th><th>Shows</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${tokens.map((t) => `<tr${t.active ? '' : ' class="revoked"'}><td>${esc(t.label || '—')}</td><td>${esc(t.scopes.join(', '))}</td><td>${when(t.created_at)}</td><td>${when(t.last_used_at) || 'never'}</td><td>${t.active ? `<form method="post" action="/dashboard/overlay-tokens/${esc(t.id)}/revoke">${hidden({ csrf, idem: `${idem}-r-${t.id}` })}<button class="btn ghost" type="submit">Revoke</button></form>` : 'revoked'}</td></tr>`).join('')}</tbody></table>` : ''}
  <form method="post" action="/dashboard/overlay-tokens">${hidden({ csrf, idem: `${idem}-t` })}
    <label>Label <input name="label" maxlength="80" placeholder="OBS main scene"></label>
    <label><input type="checkbox" name="scope_alerts" value="1" checked> Alerts</label>
    <label><input type="checkbox" name="scope_goals" value="1" checked> Goals</label>
    <button class="btn" type="submit">Create overlay link</button>
  </form>
  ${alertCfg ? `<form method="post" action="/dashboard/overlay-configs/${esc(alertCfg.id)}">${hidden({ csrf, idem: `${idem}-a`, revision: alertCfg.revision })}
    <h3>Alert settings</h3>
    <label>Show alerts from <input type="number" name="min_amount" min="1" value="${s.min_amount}"> Vibes</label>
    <label>Alert time (ms) <input type="number" name="duration_ms" min="1000" max="60000" value="${s.duration_ms}"></label>
    <label><input type="checkbox" name="show_message" value="1"${s.show_message ? ' checked' : ''}> Show the message</label>
    <label><input type="checkbox" name="speak_message" value="1"${s.speak_message ? ' checked' : ''}> Read text-to-speech requests in the overlay (browser voice)</label>
    <label>Sound (https link) <input type="url" name="sound_url" value="${esc(s.sound_url || '')}"></label>
    <label>Image (https link) <input type="url" name="image_url" value="${esc(s.image_url || '')}"></label>
    <input type="hidden" name="show_amount" value="1">
    <button class="btn ghost" type="submit">Save alert settings</button>
  </form>` : ''}
</section>
${moderationCard({ p, csrf, idem, mod })}
<section class="card"><h2>Test your setup</h2>
  <p>Runs the whole path — overlay alert, goal widget, delivery — marked as a simulation. Nothing is charged and nothing is counted. ${chatAdapter === 'none' ? '' : 'Chat delivery of simulations stays inside Tips.'}</p>
  <form method="post" action="/dashboard/simulate">${hidden({ csrf, idem: `${idem}-s` })}
    <label>Kind <select name="kind"><option value="tip">Tip</option><option value="paid_message">Paid message</option>${p.tts_enabled ? '<option value="tts">Text-to-speech</option>' : ''}${p.media_requests_enabled ? '<option value="media_request">Media request</option>' : ''}${p.sounds_enabled && sounds.length ? '<option value="sound">Sound</option>' : ''}</select></label>
    <label>Amount <input type="number" name="amount" min="1" value="${Math.max(p.min_amount, p.paid_message_min, 100)}"></label>
    <label>Name <input name="supporter_name" value="Test supporter" maxlength="80"></label>
    <label>Message <input name="message" value="This is a test alert" maxlength="300"></label>
    <label class="when-media">Media link (for a media request) <input type="url" name="media_url" placeholder="https://www.youtube.com/watch?v=…"></label>
    ${p.sounds_enabled && sounds.length ? `<label>Sound (for a sound) <select name="sound_id">${sounds.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>` : ''}
    <button class="btn" type="submit">Send a test</button>
  </form>
</section>
<section class="card"><h2>Recent</h2>
  ${recent.length ? `<table class="list"><thead><tr><th>When</th><th>From</th><th>What</th><th class="num">Vibes</th><th>Payment</th><th>Delivery</th></tr></thead><tbody>${recent.map((r) => receiptRow(r, 'creator')).join('')}</tbody></table>` : '<p>Nothing yet.</p>'}
  ${deliveries.length ? `<details><summary>Overlay deliveries</summary><table class="list"><thead><tr><th>#</th><th>Kind</th><th>Status</th><th>Sent</th><th>Created</th></tr></thead><tbody>${deliveries.map((d) => `<tr${d.test ? ' class="test"' : ''}><td>${d.seq}</td><td>${esc(d.kind)}${d.test ? ' (test)' : ''}</td><td>${esc(d.status)}</td><td>${d.sends}×</td><td>${when(d.created_at)}</td></tr>`).join('')}</tbody></table></details>` : ''}
</section>`;
}

const MOD_LABEL = { visible: 'Shown', held: 'Held for review', hidden: 'Hidden' };
const ROLE_LABEL = { filter: 'word filter', creator: 'you', moderator: 'a moderator', service: 'a service' };

/** The dashboard's moderation card: the word filter, moderators and invitations, the latest outcomes. */
function moderationCard({ p, csrf, idem, mod }) {
    const fl = p.filter;
    const moderators = mod.moderators || [];
    const invites = mod.invites || [];
    return `<section class="card" id="moderation"><h2>Moderation</h2>
  <p>${mod.held ? `<b>${n(mod.held)}</b> paid message${mod.held === 1 ? ' is' : 's are'} held for review. ` : ''}<a href="/moderate/${esc(p.handle)}">Review paid messages</a> — hide one from overlays and your pages, or show a held one. Hiding never refunds or uncounts a payment.</p>
  <form method="post" action="/dashboard/filter">${hidden({ csrf, idem: `${idem}-f` })}
    <h3>Word filter</h3>
    <label>Blocked words or phrases, one per line <small>(matched as whole words, any letter case; only you see this list)</small><textarea name="words" rows="4" maxlength="12000">${esc(fl.words.join('\n'))}</textarea></label>
    <label>When a paid message or a name contains one <select name="action"><option value="mask"${fl.action === 'mask' ? ' selected' : ''}>star the words out (and skip them in text-to-speech)</option><option value="hold"${fl.action === 'hold' ? ' selected' : ''}>hold it until you or a moderator reviews it</option></select></label>
    <label><input type="checkbox" name="links" value="1"${fl.links ? ' checked' : ''}> Replace links in paid messages with [link]</label>
    <button class="btn ghost" type="submit">Save the filter</button>
  </form>
  <h3>Moderators</h3>
  ${moderators.length ? `<ul class="plain">${moderators.map((m) => `<li>${esc(m.name || m.moderator.id)} <small>since ${when(m.added_at)}</small> <form class="inline" method="post" action="/dashboard/moderators/${esc(m.moderator.id)}/remove">${hidden({ csrf, idem: `${idem}-m-${m.moderator.id}` })}<button class="btn ghost" type="submit">Remove</button></form></li>`).join('')}</ul>` : '<p>No moderators yet.</p>'}
  ${invites.length ? `<p class="fine">Open invitations: ${invites.map((x) => `created ${when(x.created_at)}, expires ${when(x.expires_at)} <form class="inline" method="post" action="/dashboard/moderator-invites/${esc(x.id)}/revoke">${hidden({ csrf, idem: `${idem}-ri-${x.id}` })}<button class="btn ghost" type="submit">Revoke</button></form>`).join(' · ')}</p>` : ''}
  <form method="post" action="/dashboard/moderator-invites">${hidden({ csrf, idem: `${idem}-i` })}<button class="btn ghost" type="submit">Create a moderator invitation link</button></form>
  ${mod.log && mod.log.length ? `<details><summary>Latest moderation</summary><table class="list"><thead><tr><th>When</th><th>What</th><th>By</th><th>Receipt</th></tr></thead><tbody>${mod.log.map((l) => `<tr><td>${when(l.created_at)}</td><td>${esc(l.action)}</td><td>${esc(ROLE_LABEL[l.by_role] || l.by_role)}</td><td><a href="/receipts/${esc(l.interaction_id)}"><code>${esc(l.interaction_id.slice(-8))}</code></a></td></tr>`).join('')}</tbody></table></details>` : ''}
  ${mod.moderating && mod.moderating.length ? `<p class="fine">You moderate: ${mod.moderating.map((c) => `<a href="/moderate/${esc(c.handle)}">${esc(c.display_name)}</a>`).join(', ')}</p>` : ''}
</section>`;
}

/** /moderate/<handle>: paid messages for the creator and their moderators to review. */
function moderatePage({ profile, rows, state, next, csrf, idem, flash, error, isCreator }) {
    const tab = (k, label) => `<a href="/moderate/${esc(profile.handle)}?state=${k}"${state === k ? ' aria-current="page"' : ''}>${label}</a>`;
    const item = (r) => {
        const what = [r.message && `<p class="msg">${esc(r.message)}</p>`, r.tts_text && `<p class="msg"><small>Read out:</small> ${esc(r.tts_text)}</p>`, r.media_url && `<p class="msg"><small>Media:</small> ${esc(r.media_url)}</p>`].filter(Boolean).join('');
        const act = r.moderation.state === 'visible' ? 'hide' : 'restore';
        const btn = r.moderation.state === 'held' ? 'Show it now' : act === 'hide' ? 'Hide' : 'Show again';
        return `<li class="mod-item ${esc(r.moderation.state)}${r.test ? ' test' : ''}">
  <div><b>${esc(r.supporter_name)}</b> · ${esc(KIND_LABEL[r.kind])}${r.amount != null ? ` · ${n(r.amount)} Vibes` : ''} · <small>${when(r.created_at)}${r.test ? ' · simulation' : ''}${r.payment_state === 'pending' ? ' · payment pending' : ''}</small>
    <span class="pill">${esc(MOD_LABEL[r.moderation.state])}${r.moderation.filtered ? ' · filtered' : ''}</span></div>
  ${what || '<p class="msg"><small>No message.</small></p>'}
  <form class="inline" method="post" action="/moderate/${esc(profile.handle)}/${esc(r.id)}/${act}">${hidden({ csrf, idem: `${idem}-${r.id}` })}
    ${act === 'hide' ? '<label>Note <small>(optional, only in your log)</small> <input type="text" name="reason" maxlength="200"></label>' : ''}
    <button class="btn${act === 'hide' ? ' ghost' : ''}" type="submit">${btn}</button></form>
</li>`;
    };
    return `<h1>Paid messages — ${esc(profile.display_name)}</h1>
${flash ? `<p class="notice">${esc(flash)}</p>` : ''}${errorBox(error)}
<p class="fine">${isCreator ? 'You and your moderators' : `You moderate ${esc(profile.display_name)}'s page. You`} can hide a paid message from overlays, chat still to come and the public pages, or show one the word filter held. The payment is never touched. Private messages and hidden amounts stay private here too.</p>
<nav class="tabs">${tab('held', 'Held')} ${tab('visible', 'Shown')} ${tab('hidden', 'Hidden')} ${tab('all', 'All')}</nav>
${rows.length ? `<ul class="mod-list">${rows.map(item).join('')}</ul>` : '<p>Nothing here.</p>'}
${next ? `<p><a href="/moderate/${esc(profile.handle)}?state=${esc(state)}&cursor=${esc(next)}">Older</a></p>` : ''}`;
}

/** /start: what the creator's page will be, and the one button that switches it on. */
function startPage({ profile: p, csrf, idem }) {
    return `<h1>Your tip page</h1>
<section class="card">
  <p>Your page will be <b>openvibe.tips/${esc(p.handle)}</b>, as ${esc(p.display_name)}, from your OpenVibe account.</p>
  <ul>
    <li>Viewers tip you in Vibes, with a message if they like. OpenVibe.Billing settles every tip and keeps your Vibes.</li>
    <li>Tips count toward your goals, and appear in your OpenVibe.Live chat and on your channel's goal.</li>
    <li>Text-to-speech, media requests and paid sounds stay off until you switch them on in the dashboard.</li>
    <li>The page is public and search engines may index it. You can switch it off at any time.</li>
  </ul>
  <form method="post" action="/start">${hidden({ csrf, idem })}<button class="btn" type="submit">Turn on my tip page</button></form>
  <p class="fine"><a href="/dashboard">Set it up in the dashboard first</a></p>
</section>`;
}

function invitePage({ profile, csrf, idem, secret, isSelf }) {
    return `<h1>Moderate ${esc(profile.display_name)}</h1>
<section class="card">
  ${isSelf ? '<p>This invitation is for your own page: you moderate it already.</p>' : `<p>${esc(profile.display_name)} invited you to moderate the paid messages on their OpenVibe.Tips page: you will be able to hide a paid message from their overlays and pages, and show one their word filter held. You will not see payments, private messages or hidden amounts.</p>
  <form method="post" action="/moderate/invite/${esc(secret)}">${hidden({ csrf, idem })}<button class="btn" type="submit">Become a moderator</button></form>`}
</section>`;
}

function inviteCreated({ out }) {
    return `<h1>Moderator invitation</h1>
<p class="notice">Copy it now: this is the only time it is shown. Whoever opens it signed in becomes one of your moderators, so send it only to them. It works once and expires ${when(out.expires_at)}.</p>
<p><label>Invitation link<input class="copy" type="text" readonly value="${esc(out.url)}" onclick="this.select()"></label></p>
<p><a class="btn" href="/dashboard#moderation">Back to the dashboard</a></p>`;
}

function tokenCreated({ out }) {
    return `<h1>Overlay link created</h1>
<p class="notice">Copy it now: this is the only time it is shown. Anyone with the link can see your alerts and goals (nothing else), so treat it like a password and revoke it if it leaks.</p>
<p><label>Overlay URL (OBS Browser Source, 800 × 600, transparent)<input class="copy" type="text" readonly value="${esc(out.overlay_url)}" onclick="this.select()"></label></p>
<p><a class="btn" href="/dashboard">Back to the dashboard</a></p>`;
}

function errorPage({ status, title, message }) {
    return `<section class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">OpenVibe.Tips home</a></p></section><!-- ${status} -->`;
}

module.exports = {
    HOME_PANE_IDS, NEW_PAGE_MINIMUMS, HOME_FAQ, SUPPORT_SERVICES, home, creatorPage, goalsPage, supportersPage, receiptsPage, erasePage, receiptPage, dashboard, moderatePage, startPage, invitePage, inviteCreated, tokenCreated, errorPage, tipForm };
