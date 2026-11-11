/* Shared picker for the dashboard's existing multipart paid-sound form. */
(function () {
    'use strict';
    var form = document.querySelector('form.sound-upload');
    var input = form && form.querySelector('[data-sound-file]');
    var root = form && form.querySelector('[data-sound-picker]');
    var error = form && form.querySelector('[data-sound-error]');
    if (!form || !input || !root || !error || !window.OVUpload || !window.DataTransfer) return;

    var file = null;
    var row = null;
    var meter = null;
    var sending = false;
    function fail(message) { error.textContent = message; error.hidden = false; }
    function clear() {
        file = null; row = null; input.value = '';
        if (meter) meter.destroy();
        meter = null;
    }
    var pick = OVUpload.picker(root, {
        label: 'Choose an MP3, OGG or WAV sound',
        accept: input.accept, multiple: false, onRemove: clear,
        onFile: function (next, nextRow) {
            if (row) { row.dispatchEvent(new Event('remove')); row.remove(); }
            error.hidden = true;
            if (!['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav'].includes(next.type) &&
                !/\.(mp3|ogg|wav)$/i.test(next.name)) {
                nextRow.dispatchEvent(new Event('remove')); nextRow.remove();
                return fail('Choose an MP3, OGG or WAV sound.');
            }
            if (next.size > Number(root.dataset.maxBytes)) {
                nextRow.dispatchEvent(new Event('remove')); nextRow.remove();
                return fail('A sound can be at most 512 KB.');
            }
            var transfer = new DataTransfer();
            transfer.items.add(next);
            input.files = transfer.files;
            file = next; row = nextRow;
            var meterRoot = document.createElement('div');
            row.append(meterRoot);
            meter = OVUpload.progress(meterRoot, { compact: true, onRetry: send });
            meter.update({ state: 'waiting', total: file.size });
        }
    });
    input.required = false;
    input.hidden = true;

    function send() {
        if (sending || !file) return;
        sending = true;
        error.hidden = true;
        var button = form.querySelector('[type="submit"]');
        var remove = row.querySelector('.ov-upload__remove');
        button.disabled = true; remove.disabled = true;
        var size = file.size;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);
        xhr.upload.onprogress = function (event) {
            if (event.lengthComputable) meter.update({ state: 'sending', done: Math.min(event.loaded, size), total: event.total });
        };
        xhr.upload.onload = function () { meter.update({ state: 'processing', done: size, total: size }); };
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 400 && xhr.responseURL && xhr.responseURL !== form.action) {
                meter.update({ state: 'done', done: size, total: size });
                window.location.assign(xhr.responseURL);
                return;
            }
            sending = false; button.disabled = false; remove.disabled = false;
            var page = new DOMParser().parseFromString(xhr.responseText || '', 'text/html');
            var reason = page.querySelector('.notice.error[role="alert"]');
            meter.update({ state: 'failed', message: reason ? reason.textContent : 'The sound could not be added. Try again.' });
        };
        xhr.onerror = function () {
            sending = false; button.disabled = false; remove.disabled = false;
            meter.update({ state: 'failed', message: 'The connection stopped. Try again.' });
        };
        meter.update({ state: 'sending', done: 0, total: size });
        xhr.send(new FormData(form));
    }
    form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (!file) { fail('Choose a sound first.'); pick.input.focus(); return; }
        send();
    });
})();
