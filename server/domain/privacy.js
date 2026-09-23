'use strict';

/**
 * What a supporter lets the public see of their interaction, and the one public shape of it.
 *
 * A supporter chooses per interaction (the tip form, or `privacy` on the API):
 *
 *   anonymous        their name reads "Anonymous" to everyone but themselves: the creator, moderators,
 *                    overlays, chat lines, public pages, other products and events. Nobody but the
 *                    supporter gets their subject from Tips for it (Billing, which moved the money,
 *                    has its own record).
 *   hide_amount      the amount is left out of overlays, chat lines and public pages, and the
 *                    interaction stays off the supporters leaderboard. The creator still sees it
 *                    (it is their money), internal events still carry it (goals and reconciliation
 *                    need it), and a public goal bar still moves by it.
 *   private_message  a tip's message is for the creator only: never on an overlay, in chat or on a
 *                    public page. Paid messages, text-to-speech and media requests are shown on
 *                    stream by definition, so they cannot be private.
 *
 * An interaction the supporter erased (erased_at) reads like an anonymous one with no message.
 *
 * publicView() is the only shape that leaves Tips for the public: overlay alerts, chat jobs, the
 * supporters and goals pages, and the `public` block of API answers. It also applies moderation
 * (moderation.js): a held or hidden interaction shows nothing but that it is hidden, and the creator's
 * word filter (filter.js) stars blocked words out of the name and message and drops them from what
 * text-to-speech reads.
 */
const { fail, json } = require('../util');
const filter = require('./filter');

const ANONYMOUS = 'Anonymous';
const FLAGS = ['anonymous', 'hide_amount', 'private_message'];
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';

/** The `privacy` object of a request → { anonymous, hide_amount, private_message } (booleans). */
function parsePrivacy(v, kind) {
    if (v != null && (typeof v !== 'object' || Array.isArray(v))) fail(422, 'tips.invalid_input', 'privacy must be an object { anonymous, hide_amount, private_message }');
    const src = v || {};
    const unknown = Object.keys(src).filter((k) => !FLAGS.includes(k));
    if (unknown.length) fail(422, 'tips.invalid_input', `privacy has no field ${unknown[0]} (only ${FLAGS.join(', ')})`);
    const out = { anonymous: truthy(src.anonymous), hide_amount: truthy(src.hide_amount), private_message: truthy(src.private_message) };
    if (out.private_message && kind && kind !== 'tip') {
        fail(422, 'tips.invalid_input', 'paid messages, text-to-speech and media requests are shown on stream; send a tip to keep a message private');
    }
    return out;
}

const isAnonymous = (i) => !!(i.anonymous || i.erased_at);
const privacyOf = (i) => ({ anonymous: isAnonymous(i), hide_amount: !!i.hide_amount, private_message: !!i.private_message });

/** The name anyone but the supporter sees. */
function publicName(i) {
    if (isAnonymous(i)) return ANONYMOUS;
    return i.supporter_name || 'Someone';
}

const isHidden = (i) => !!i.moderation && i.moderation !== 'visible';

/** The name as the public sees it, through the creator's filter (`settings` from profiles.filterOf). */
function shownName(i, settings) {
    if (isAnonymous(i)) return ANONYMOUS;
    return filter.apply(i.supporter_name || 'Someone', settings).text;
}

/**
 * The public shape of an interaction. `at` is kept from an earlier overlay payload when given, so a
 * rewritten alert keeps its time; `filter` is the creator's filter settings.
 */
function publicView(i, { at, filter: settings = null } = {}) {
    const req = json(i.request, {});
    const privateMsg = !!i.private_message || !!i.erased_at;
    const base = {
        interaction_id: i.id,
        kind: i.kind,
        amount: i.hide_amount ? null : i.amount,
        amount_hidden: !!i.hide_amount,
        currency: i.currency,
        settlement: i.settlement,
        test: !!i.test,
        at: at || i.settled_at || i.created_at,
    };
    if (isHidden(i)) return { ...base, amount: null, supporter_name: null, message: null, tts: null, media: null, hidden: true };
    const message = privateMsg || !i.message ? null : filter.apply(i.message, settings).text;
    const tts = i.kind === 'tts' && req.tts && !i.erased_at ? { text: filter.apply(req.tts.text, settings, 'speech').text, voice: req.tts.voice } : null;
    return {
        ...base,
        supporter_name: shownName(i, settings),
        message,
        tts,
        media: i.kind === 'media_request' && req.media && !i.erased_at ? { url: req.media.url } : null,
        hidden: false,
    };
}

module.exports = { ANONYMOUS, FLAGS, parsePrivacy, publicName, shownName, publicView, privacyOf, isAnonymous, isHidden, truthy };
