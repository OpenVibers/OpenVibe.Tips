'use strict';

/**
 * The creator's word filter for paid messages (and the names that come with them), applied before
 * anything is shown on an overlay, posted to chat, read out by text-to-speech or put on a public page.
 *
 *   words   the creator's blocklist: words or phrases, matched whole, case-insensitively, after Unicode
 *           NFKC normalisation (full-width and compatibility letters fold to plain ones)
 *   action  mask  the matches are starred out for display and left out of what TTS reads
 *           hold  a paid message that matches is held: nothing is shown or read until the creator
 *                 or a moderator approves it (moderation.js); the money is untouched either way
 *   links   links in a paid message are replaced by "[link]" (display) or "link" (speech), whatever
 *           the blocklist says (on by default: a link on stream is an easy phishing vector)
 *
 * Every text also loses invisible and direction-override characters (they would hide a word from
 * the filter or turn a line around on stream) and long runs of combining marks.
 */
const { fail } = require('../util');

const MAX_WORDS = 200;
const MAX_WORD_CHARS = 60;
const ACTIONS = ['mask', 'hold'];
// Zero-width, bidi embedding/override/isolate marks, word joiner, BOM, soft hyphen.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const COMBINING_RUN = /(\p{M}{2})\p{M}+/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** Invisible characters and combining-mark runs out, NFKC. */
function clean(s) {
    return String(s == null ? '' : s).replace(INVISIBLE, '').normalize('NFKC').replace(COMBINING_RUN, '$1');
}

/** The creator's input (a list, or text with one entry per line or comma) → a clean, bounded list. */
function normalizeWords(v) {
    const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\n,]/);
    const out = [];
    for (const w of raw) {
        const s = clean(w).toLowerCase().replace(/\s+/g, ' ').trim();
        if (!s) continue;
        if (s.length > MAX_WORD_CHARS) fail(422, 'tips.invalid_input', `a blocked word or phrase is at most ${MAX_WORD_CHARS} characters`);
        if (!out.includes(s)) out.push(s);
    }
    if (out.length > MAX_WORDS) fail(422, 'tips.invalid_input', `at most ${MAX_WORDS} blocked words or phrases`);
    return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cache = new Map();
/** One case-insensitive regexp matching any entry as a whole word or phrase (literal text only). */
function compile(words) {
    if (!words || !words.length) return null;
    const key = JSON.stringify(words);
    if (cache.has(key)) return cache.get(key);
    const alt = words.map((w) => w.split(' ').map(escapeRe).join('\\s+')).sort((a, b) => b.length - a.length).join('|');
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, 'giu');
    if (cache.size > 500) cache.clear();
    cache.set(key, re);
    return re;
}

/**
 * Filter one text. mode 'display' stars out a match, 'speech' drops it. Returns { text, hit } where
 * hit says a blocked word matched (links alone are not a hit).
 */
function apply(text, settings, mode = 'display') {
    if (text == null || text === '') return { text, hit: false };
    let s = clean(text);
    if (!settings || settings.links !== false) s = s.replace(URL_RE, mode === 'speech' ? 'link' : '[link]');
    const re = settings ? compile(settings.words) : null;
    let hit = false;
    if (re) {
        re.lastIndex = 0;
        s = s.replace(re, (m) => { hit = true; return mode === 'speech' ? '' : '*'.repeat([...m].length); });
        if (mode === 'speech') s = s.replace(/\s{2,}/g, ' ').trim();
    }
    return { text: s, hit };
}

/** Whether any of the texts hits a blocked word. */
function hits(settings, ...texts) {
    const re = settings ? compile(settings.words) : null;
    if (!re) return false;
    return texts.some((t) => { if (!t) return false; re.lastIndex = 0; return re.test(clean(t)); });
}

module.exports = { clean, normalizeWords, compile, apply, hits, ACTIONS, MAX_WORDS, MAX_WORD_CHARS };
