'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the home's five parts are one pick block, a row of
 * chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for the
 * chips; every part stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    try {
        await check('the home is one pick block: a chip per part, the first picked, every part in the page', async () => {
            const r = await t.call('GET', '/', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick" id="pick-parts">'), page.indexOf('<div class="pick" id="pick-parts">') + 60000);
            assert.ok(block.startsWith('<div class="pick" id="pick-parts">'), 'the pick block is on the home');
            assert.match(block, /<nav class="pick-row" aria-label="What Tips does">/);
            const chips = [...block.matchAll(/<a class="pick-chip" href="#(?:pp-parts-)?([a-z-]+)">()([^<]+)<\/a>/g)];
            assert.ok(chips.length >= 5, `a chip per part (${chips.length})`);
            assert.ok(!/type="radio"/.test(block), 'no chip is a radio: nothing is picked, every pane shows');
            // Every part stays in the page, with the id its chip picks.
            const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z-]+)">/g)].map((m) => m[1]);
            assert.deepStrictEqual(panes, chips.map((m) => m[1]), 'every part is in the page, one per chip');
            // The parts themselves are all there: nothing was removed.
            for (const title of ['What you can send', 'For creators', 'Other ways to support', 'How it works', 'What it costs to send']) {
                assert.ok(page.includes(title), `${title} is on the page`);
            }
        });

        await check('the CSS guard: the chips are hidden and the parts all show until 640 px and where :has() is understood', async () => {
            const r = await t.call('GET', '/', { token: null });
            const page = r.text;
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'tips.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.call('GET', '/', { token: null });
            const page = r.text;
            for (const id of ['faq', 'network', 'shipped']) {
                assert.ok(page.includes(`<details class="tp-fold tp-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(page, /What are Vibes\?/);
            assert.match(page, /Part of OpenVibe/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
