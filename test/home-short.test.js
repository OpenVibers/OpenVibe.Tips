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
        await check('the home shows every part: no chip row, every part in the page', async () => {
            const r = await t.call('GET', '/', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            assert.ok(!page.includes('pick-parts'), 'the pick block is gone');
            for (const title of ['What you can send', 'For creators', 'Other ways to support', 'How it works', 'What it costs to send']) {
                assert.ok(page.includes(title), `${title} is on the page`);
            }
        });

        await check('nothing hides a part or a card on a phone', async () => {
            const page = (await t.call('GET', '/', { token: null })).text;
            assert.ok(!page.includes('@supports selector(:has(*)){@media (max-width:640px){.pick:has'), 'no pick rule is written for the parts');
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'tips.css'), 'utf8');
            assert.ok(!/\.tp-cards > li:nth-child\(n\+5\) \{ display: none/.test(css), 'no card is hidden');
        });

        await check('the parts a reader rarely needs are folds that start open on every screen', async () => {
            const r = await t.call('GET', '/', { token: null });
            const page = r.text;
            for (const id of ['faq', 'network', 'shipped']) {
                assert.ok(page.includes(`<details class="tp-fold tp-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(!page.includes(`document.getElementById("${id}")`), `${id} is never closed by script`);
            }
            assert.match(page, /What are Vibes\?/);
            assert.match(page, /Part of OpenVibe/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
