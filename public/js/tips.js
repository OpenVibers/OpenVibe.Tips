// OpenVibe.Tips — progressive touches only; every form works without this file.
(function () {
    'use strict';
    document.documentElement.classList.add('js');
    function wire() {
        var form = document.querySelector('.tip-form');
        if (!form) return;
        function sync() {
            var checked = form.querySelector('input[name=kind]:checked');
            form.setAttribute('data-kind', checked ? checked.value : 'tip');
        }
        form.addEventListener('change', sync);
        sync();
    }
    document.addEventListener('DOMContentLoaded', wire);
    document.addEventListener('ov:boost:load', wire);   // a swapped-in page's tip form wires the same way
})();
