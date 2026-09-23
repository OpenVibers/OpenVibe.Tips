// OpenVibe.Tips overlay client (OBS Browser Source). The overlay link's token is in the page URL;
// this script only reads the event stream next to it. Replays after a reconnect (Last-Event-ID)
// are shown again but change nothing on the server.
(function () {
    'use strict';
    var base = location.pathname.replace(/\/+$/, '');
    var alertEl = document.getElementById('alert');
    var goalsEl = document.getElementById('goals');
    var config = { settings: { duration_ms: 8000, show_message: true, show_amount: true, template: '{name} tipped {amount} Vibes' } };
    var goals = {};
    var queue = [];
    var busy = false;
    var current = null;
    var retracted = {};
    var shown = {};
    var HIDDEN = { tip: 'sent a tip', paid_message: 'sent a paid message', tts: 'sent a message to read out', media_request: 'requested media' };

    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function fmt(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }

    function renderGoals() {
        goalsEl.textContent = '';
        Object.keys(goals).forEach(function (id) {
            var g = goals[id];
            if (g.status !== 'active') return;
            var box = el('div', 'g' + (g.reached ? ' reached' : ''));
            box.appendChild(el('div', null, g.title + ' — ' + fmt(g.current_amount) + ' / ' + fmt(g.target_amount) + ' Vibes'));
            if (g._test) box.appendChild(el('div', 'test', 'simulation — not counted'));
            var bar = el('div', 'bar'); var fill = el('span'); fill.style.width = Math.min(100, g.percent) + '%'; bar.appendChild(fill); box.appendChild(bar);
            goalsEl.appendChild(box);
        });
    }

    function next() {
        if (busy || !queue.length) return;
        busy = true;
        var a = queue.shift();
        current = a;
        var s = config.settings || {};
        alertEl.textContent = '';
        var box = el('div', 'box');
        if (s.image_url) { var img = el('img'); img.src = s.image_url; img.alt = ''; box.appendChild(img); }
        if (a.test) box.appendChild(el('div', 'test', 'test alert'));
        var title = el('div', 'title');
        // A supporter who hid the amount: the server sends none, and the line does not pretend one.
        var tpl = a.amount == null ? '{name} ' + (HIDDEN[a.kind] || HIDDEN.tip) : String(s.template || '{name} tipped {amount} Vibes');
        var parts = tpl.split(/(\{name\}|\{amount\})/);
        parts.forEach(function (p) {
            if (p === '{name}') title.appendChild(el('b', null, a.supporter_name || 'Someone'));
            else if (p === '{amount}') title.appendChild(document.createTextNode(s.show_amount === false ? '' : fmt(a.amount)));
            else title.appendChild(document.createTextNode(p));
        });
        box.appendChild(title);
        var text = a.tts ? a.tts.text : a.message;
        if (s.show_message !== false && text) box.appendChild(el('div', 'msg', text));
        alertEl.appendChild(box);
        alertEl.className = 'show';
        if (s.sound_url) { try { new Audio(s.sound_url).play().catch(function () {}); } catch (e) { /* no audio */ } }
        if (s.speak_message && a.tts && window.speechSynthesis) {
            try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(a.tts.text)); } catch (e) { /* no voice */ }
        }
        setTimeout(function () {
            if (current !== a) return;   // retracted while on screen: already cleared
            alertEl.className = '';
            setTimeout(function () { busy = false; current = null; next(); }, 400);
        }, Number(s.duration_ms) || 8000);
    }

    var es = new EventSource(base + '/events');
    es.addEventListener('hello', function (e) {
        var d = JSON.parse(e.data);
        if (d.config) config = d.config;
        goals = {};
        (d.goals || []).forEach(function (g) { goals[g.id] = g; });
        renderGoals();
    });
    es.addEventListener('config', function (e) { var d = JSON.parse(e.data); if (d.config) config = d.config; });
    es.addEventListener('alert', function (e) {
        var d = JSON.parse(e.data);
        if (shown[d.delivery_id] || retracted[d.interaction_id]) return;   // a replay of one this page already showed, or hidden since
        shown[d.delivery_id] = 1;
        queue.push(d);
        next();
    });
    es.addEventListener('goal', function (e) {
        var d = JSON.parse(e.data);
        if (!d.goal) return;
        var g = d.goal; g._test = !!d.test;
        goals[g.id] = g;
        renderGoals();
        if (d.test) setTimeout(function () { if (goals[g.id] && goals[g.id]._test) { delete goals[g.id]; renderGoals(); es.close(); location.reload(); } }, 15000);
    });
    // A moderator hid it: drop it from the queue, or take it off the screen now (and stop its voice).
    es.addEventListener('retract', function (e) {
        var d = JSON.parse(e.data);
        retracted[d.interaction_id] = 1;
        queue = queue.filter(function (a) { return a.interaction_id !== d.interaction_id; });
        if (current && current.interaction_id === d.interaction_id) {
            try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (err) { /* no voice */ }
            alertEl.className = ''; alertEl.textContent = '';
            current = null;
            setTimeout(function () { busy = false; next(); }, 400);
        }
    });
    es.addEventListener('revoked', function () { es.close(); alertEl.textContent = ''; goalsEl.textContent = ''; });
})();
