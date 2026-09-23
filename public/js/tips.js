// OpenVibe.Tips — progressive touches only; every form works without this file.
(function () {
    'use strict';
    document.documentElement.classList.add('js');
    document.addEventListener('DOMContentLoaded', function () {
        var form = document.querySelector('.tip-form');
        if (!form) return;
        function sync() {
            var checked = form.querySelector('input[name=kind]:checked');
            form.setAttribute('data-kind', checked ? checked.value : 'tip');
        }
        form.addEventListener('change', sync);
        sync();
    });
})();
