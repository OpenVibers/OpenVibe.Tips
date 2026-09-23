'use strict';

/**
 * Server-rendered page bodies. Plain HTML forms everywhere: a supporter can tip, and a creator can
 * run the dashboard, with JavaScript switched off. Copy rules: no pricing claims, no pleading copy —
 * the creator's own headline is the only pitch on their page.
 */
const { esc } = require('./layout');
const { VOICES } = require('../domain/profiles');

const n = (v) => Number(v || 0).toLocaleString('en-US');
const when = (s) => (s ? esc(String(s).replace('T', ' ').slice(0, 16)) + ' UTC' : '');
const KIND_LABEL = { tip: 'Tip', paid_message: 'Paid message', tts: 'Text-to-speech', media_request: 'Media request' };
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

function home({ creators }) {
    return `<section class="hero">
  <h1>Support the creators you watch</h1>
  <p>Tip a creator with Vibes, send a highlighted paid message, have your message read out, or request a video for their stream. Creators set goals and show every tip on stream with an overlay.</p>
  <p class="actions"><a class="btn" href="/dashboard">Open your creator dashboard</a> <a class="btn ghost" href="/receipts">Your receipts</a></p>
</section>
<section>
  <h2>How it works</h2>
  <ol class="steps">
    <li><b>Pick a creator.</b> Every creator who switched their page on has one at openvibe.tips/<i>name</i>.</li>
    <li><b>Choose what to send.</b> A tip, a paid message, text-to-speech or a media request, within the creator's own limits.</li>
    <li><b>Pay with Vibes.</b> From your Vibes balance, or through checkout. Payments are handled by OpenVibe.Billing; your receipt shows when the payment settled and when your message was delivered.</li>
  </ol>
</section>
${creators.length ? `<section><h2>Creators on OpenVibe.Tips</h2><ul class="creators">${creators.map((c) => `<li><a href="/${esc(c.handle)}">${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" width="40" height="40" loading="lazy">` : ''}<span>${esc(c.display_name)}</span></a></li>`).join('')}</ul></section>` : ''}`;
}

/** The tip form: every field works as a plain POST. */
function tipForm({ profile, goals, viewer, csrf, idem, values = {}, providers, error }) {
    const kinds = [['tip', 'Tip', profile.min_amount]];
    kinds.push(['paid_message', 'Paid message (highlighted in chat)', Math.max(profile.min_amount, profile.paid_message_min)]);
    if (profile.tts_enabled) kinds.push(['tts', 'Text-to-speech (read out on stream)', Math.max(profile.min_amount, profile.tts_min_amount)]);
    if (profile.media_requests_enabled) kinds.push(['media_request', 'Media request', Math.max(profile.min_amount, profile.media_request_min)]);
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

function creatorPage({ profile, goals, viewer, csrf, idem, values, providers, error, ownerPreview }) {
    const active = goals.filter((g) => g.status === 'active');
    return `${ownerPreview ? '<p class="notice">Your page is switched off: only you can see it, and search engines are told not to index it. Switch it on in the <a href="/dashboard">dashboard</a>.</p>' : ''}
<section class="creator-head">
  ${profile.avatar_url ? `<img class="avatar" src="${esc(profile.avatar_url)}" alt="" width="96" height="96">` : ''}
  <div><h1>${esc(profile.display_name)}</h1>${profile.headline ? `<p class="headline">${esc(profile.headline)}</p>` : ''}
  <p class="links"><a href="https://openvibe.live/@${esc(profile.handle)}">Watch on OpenVibe.Live</a> · <a href="/${esc(profile.handle)}/goals">Goals</a>${profile.page.supporters_page ? ` · <a href="/${esc(profile.handle)}/supporters">Supporters</a>` : ''}</p></div>
</section>
${active.length ? `<section><h2>Goals</h2>${active.map(goalCard).join('')}</section>` : ''}
${tipForm({ profile, goals, viewer, csrf, idem, values, providers, error })}`;
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

function dashboard({ profile, goals, tokens, configs, totals, recent, deliveries, csrf, idem, flash, error, connected, chatAdapter, mod = {} }) {
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
    <p class="fine">Simulations (${n(totals.simulations)}) are never counted. Your balance and cash-outs are on OpenVibe.Live until Billing takes over.</p>
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
    <label>Kind <select name="kind"><option value="tip">Tip</option><option value="paid_message">Paid message</option>${p.tts_enabled ? '<option value="tts">Text-to-speech</option>' : ''}${p.media_requests_enabled ? '<option value="media_request">Media request</option>' : ''}</select></label>
    <label>Amount <input type="number" name="amount" min="1" value="${Math.max(p.min_amount, p.paid_message_min, 100)}"></label>
    <label>Name <input name="supporter_name" value="Test supporter" maxlength="80"></label>
    <label>Message <input name="message" value="This is a test alert" maxlength="300"></label>
    <label class="when-media">Media link (for a media request) <input type="url" name="media_url" placeholder="https://www.youtube.com/watch?v=…"></label>
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

module.exports = { home, creatorPage, goalsPage, supportersPage, receiptsPage, erasePage, receiptPage, dashboard, moderatePage, invitePage, inviteCreated, tokenCreated, errorPage, tipForm };
