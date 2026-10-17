'use strict';
// Paid sounds (the owner's "paid soundboard … triggers"): a creator uploads short sounds from the dashboard (a plain
// multipart form, no script needed), switches paid sounds on, a supporter pays to play one, the overlay alert
// carries it and the chat line names it. Files are recognised by their bytes and served as audio that cannot run.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const multipart = require('../server/web/multipart');

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(200, 0x55)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 0x11)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(200, 0)]);

(async () => {
    await check('multipart: fields and one file; anything malformed is refused, not half-read', async () => {
        const b = 'XyZ123';
        const body = Buffer.concat([
            Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\ntok\r\n`),
            Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="horn.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`), MP3,
            Buffer.from(`\r\n--${b}--\r\n`),
        ]);
        const out = multipart.parse(body, `multipart/form-data; boundary=${b}`);
        assert.strictEqual(out.fields.csrf, 'tok');
        assert.strictEqual(out.file.filename, 'horn.mp3');
        assert.ok(out.file.data.equals(MP3), 'the file bytes, CRLFs inside it untouched');
        assert.strictEqual(multipart.parse(body, 'multipart/form-data; boundary=other'), null);
        assert.strictEqual(multipart.parse(body.slice(0, body.length - 10), `multipart/form-data; boundary=${b}`), null, 'a cut body');
        const two = Buffer.concat([body.slice(0, body.length - `--${b}--\r\n`.length), Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="f2"; filename="x.mp3"\r\n\r\n`), MP3, Buffer.from(`\r\n--${b}--\r\n`)]);
        assert.strictEqual(multipart.parse(two, `multipart/form-data; boundary=${b}`), null, 'one file per upload');
    });

    const t = await boot();
    const { billing, domain } = t;
    const alex = await t.creator('alex');
    const bob = await t.creator('bob');
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 10_000);
    const cookie = (u) => `ov_token=${t.network.signUser(u)}`;
    const get = async (p, u) => { const r = await fetch(t.base + p, { headers: u ? { Cookie: cookie(u) } : {}, redirect: 'manual' }); return { status: r.status, headers: r.headers, text: await r.text(), r }; };
    const field = (html, name) => { const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`)); return m ? m[1] : null; };
    const upload = async (u, { name, file, filename = 'sound.mp3', csrf }) => {
        const fd = new FormData();
        if (csrf !== null) fd.append('csrf', csrf || field((await get('/dashboard', u)).text, 'csrf'));
        if (name != null) fd.append('name', name);
        fd.append('file', new Blob([file]), filename);
        const r = await fetch(`${t.base}/dashboard/sounds`, { method: 'POST', body: fd, redirect: 'manual', headers: { Cookie: cookie(u) } });
        return { status: r.status, location: r.headers.get('location'), text: await r.text() };
    };
    let horn;

    await check('the dashboard uploads a sound with a plain multipart form; the bytes decide what it is', async () => {
        const page = await get('/dashboard', alex);
        assert.match(page.text, /id="sounds"/);
        assert.match(page.text, /enctype="multipart\/form-data"/);
        const ok = await upload(alex, { name: 'Airhorn', file: MP3 });
        assert.strictEqual(ok.status, 303, ok.text.slice(0, 300));
        assert.match(ok.location, /done=Sound%20added/);
        const fake = await upload(alex, { name: 'Not audio', file: Buffer.from('<script>alert(1)</script> and some more text'), filename: 'evil.mp3' });
        assert.strictEqual(fake.status, 400);
        assert.match(fake.text, /MP3, OGG or WAV/);
        const forged = await upload(alex, { name: 'Forged', file: MP3, csrf: 'nope' });
        assert.strictEqual(forged.status, 403);
        assert.strictEqual((await upload(alex, { file: OGG, filename: 'Rimshot.ogg' })).status, 303, 'the file name names it when the name is empty');
        const list = await domain.sounds.list(domain.db, alex.subject);
        assert.deepStrictEqual(list.map((x) => [x.name, x.mime]), [['Airhorn', 'audio/mpeg'], ['Rimshot', 'audio/ogg']]);
        horn = list[0];
        await domain.sounds.add(bob.subject, { name: 'Bob sound', data: WAV });
    });

    await check('a sound is served as its own audio type, never sniffed, sandboxed and cached for good', async () => {
        const r = await fetch(`${t.base}${horn.url}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-type'), 'audio/mpeg');
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
        assert.match(r.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
        assert.match(r.headers.get('cache-control'), /immutable/);
        assert.ok(Buffer.from(await r.arrayBuffer()).equals(MP3));
        assert.strictEqual((await fetch(`${t.base}/sounds/tsnd_00000000000000000000000000`)).status, 404);
    });

    await check('switched off, nobody can buy a sound; switched on, the page offers them with a preview', async () => {
        assert.ok(!(await get('/alex', viewer)).text.includes('name="sound_id"'));
        const off = await t.call('POST', '/api/v1/sound-requests', { user: viewer, body: { creator: 'alex', amount: 100, sound: { id: horn.id } } });
        assert.strictEqual(off.status, 409);
        assert.strictEqual(off.json.code, 'tips.sounds_disabled');
        const on = await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { sounds_enabled: true, sound_min: 60 } });
        assert.strictEqual(on.status, 200, on.text);
        assert.deepStrictEqual(on.json.profile.sounds, { enabled: true });
        assert.strictEqual(on.json.profile.minimums.sound, 60);
        const page = await get('/alex', viewer);
        assert.match(page.text, /A sound \(played on stream\)/);
        assert.match(page.text, new RegExp(`name="sound_id" value="${horn.id}" checked`));
        assert.match(page.text, new RegExp(`<audio controls preload="none" src="/sounds/${horn.id}">`));
        const api = await t.call('GET', '/api/v1/profiles/alex/sounds', { token: null });
        assert.strictEqual(api.status, 200);
        assert.deepStrictEqual(api.json.sounds.map((x) => x.url), [`http://tips.test/sounds/${horn.id}`, `http://tips.test${(await domain.sounds.list(domain.db, alex.subject))[1].url}`]);
        assert.strictEqual(api.json.minimum, 60);
    });

    await check('a supporter pays to play one of the creator\'s sounds: the overlay plays it and chat names it', async () => {
        const low = await t.call('POST', '/api/v1/sound-requests', { user: viewer, body: { creator: 'alex', amount: 10, sound: { id: horn.id } } });
        assert.strictEqual(low.status, 422);
        const foreign = (await domain.sounds.list(domain.db, bob.subject))[0];
        const other = await t.call('POST', '/api/v1/sound-requests', { user: viewer, body: { creator: 'alex', amount: 100, sound: { id: foreign.id } } });
        assert.strictEqual(other.status, 422, 'another creator\'s sound is not on this page');
        const svc = await t.call('POST', '/api/v1/sound-requests', { cap: ['tips.checkout.create'], body: { creator: 'alex', supporter: viewer.subject, amount: 100, sound: { id: horn.id } } });
        assert.strictEqual(svc.status, 403, 'a service needs tips.sound.request');
        const r = await t.call('POST', '/api/v1/sound-requests', { user: viewer, body: { creator: 'alex', amount: 75, sound: { id: horn.id } } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.interaction.kind, 'sound');
        assert.strictEqual(r.json.interaction.payment.state, 'settled');
        assert.deepStrictEqual(r.json.interaction.sound, { id: horn.id, name: 'Airhorn', url: `/sounds/${horn.id}` });
        const alerts = await domain.overlays.recentAlerts(domain.db, alex.subject);
        assert.deepStrictEqual(alerts[0].sound, { id: horn.id, name: 'Airhorn', url: `/sounds/${horn.id}` }, 'the overlay alert carries the sound to play');
        await domain.effects.drain();
        const line = t.adapters.test.jobs.find((j) => j.interaction.id === r.json.interaction.id);
        assert.ok(line, 'a chat line');
        assert.strictEqual(line.effect, 'chat_line');
        assert.strictEqual(line.text, 'Viewer played “Airhorn” for 75 Vibes');
    });

    await check('the creator tests a sound from the dashboard, deletes one, and keeps 12 at most', async () => {
        const page = await get('/dashboard', alex);
        assert.match(page.text, /<option value="sound">Sound<\/option>/);
        const csrf = field(page.text, 'csrf');
        const del = await fetch(`${t.base}/dashboard/sounds/${horn.id}/delete`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie(alex), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }).toString() });
        assert.strictEqual(del.status, 303);
        assert.strictEqual((await fetch(`${t.base}${horn.url}`)).status, 404);
        const left = (await domain.sounds.list(domain.db, alex.subject)).length;
        for (let i = left; i < 12; i++) await domain.sounds.add(alex.subject, { name: `S${i}`, data: WAV });
        await assert.rejects(domain.sounds.add(alex.subject, { name: 'Thirteenth', data: WAV }), (e) => e.code === 'tips.too_many_sounds');
        await assert.rejects(domain.sounds.add(alex.subject, { name: 'Huge', data: Buffer.concat([MP3, Buffer.alloc(600 * 1024)]) }), (e) => e.code === 'tips.sound_too_large');
    });

    await done(t);
})();
