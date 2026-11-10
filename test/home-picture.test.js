'use strict';
// The home's picture is Tips' own: a tip arriving on a stream and the goal it moves (the owner, 2026-11-09: no more
// "generic circled" homes). It is an example and says so. And the cards under it are a row to swipe on a phone: the
// stylesheet used to hide every card after the fourth.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    await check('the home draws a tip arriving on a stream, labelled as an example', async () => {
        const home = await (await fetch(`${t.base}/`)).text();
        const scene = (home.match(/<figure class="tp-scene"[\s\S]*?<\/figure>/) || [''])[0];
        assert.ok(scene, 'the scene is in the hero');
        assert.match(scene, /aria-label="An example: a tip arriving on a creator&#39;s stream"|aria-label="An example: a tip arriving on a creator's stream"/);
        assert.match(scene, /<b>maru tipped 500 Vibes<\/b>/);
        assert.match(scene, /<div class="tp-scene-bar" role="img" aria-label="62 percent of the goal">/);
        assert.match(scene, /<figcaption>An example: /, 'it says it is an example');
        assert.ok(!/class="sc-orbit|sc-orbit-/.test(home), 'the generic orbit is gone from this home');
    });
    await check('the stylesheet keeps the picture still under reduced motion and hides no card on a phone', async () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'tips.css'), 'utf8');
        assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.tp-scene-alert, \.tp-scene-bar i \{ animation: none; \} \}/);
        assert.match(css, /html\[data-ov-motion=reduced\] \.tp-scene-alert/);
        assert.ok(!/\.tp-cards > li:nth-child\(n\+5\) \{ display: none/.test(css), 'no card is hidden on a phone');
        assert.match(css, /\.tp-cards \{ grid-template-columns: none; grid-auto-flow: column;/, 'they are a row to swipe');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
