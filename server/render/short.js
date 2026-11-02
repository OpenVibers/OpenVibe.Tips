'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickBlock()  several blocks of the same kind, one at a time on a phone, picked with a row of chips. Radio
 *                inputs and :has(), no script: every block stays in the page for crawlers, and a wider screen (or a
 *                browser without :has()) shows them all and no chips.
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for both lives in public/css/tips.css; the rule that shows the picked block is written for the page,
 * because there is one per block.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A pick block. The panes are the page's own blocks; each one keeps its heading on a wide screen, and on a phone the
 * heading gives way to the chip that names it.
 *
 *   pickBlock({ key, label, head, panes })   panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', panes }) {
    // A pane with nothing to show is left out, so the chips and the rules that show them match the page.
    panes = (panes || []).filter((p) => p.html);
    if (!panes.length) return '';
    const chips = panes.map((p) => `<a class="pick-chip" href="#${esc(p.id)}">${esc(p.label)}</a>`).join('');
    // The pane carries the id the page already links to (an anchor in the hero, for instance), so a link to it still
    // opens that pane on a phone (the CSS shows the pane a link points at).
    const body = panes.map((p) => `<div class="pick-pane" id="${esc(p.id)}">${p.html}</div>`).join('');
    return `<div class="pick" id="pick-${esc(key)}"><div class="pick-bar"><div class="pick-head"><h2>${esc(head || label)}</h2></div><nav class="pick-row" aria-label="${esc(label)}">${chips}</nav></div><div class="pick-body">${body}</div></div>`;
}



/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return `<details class="tp-fold tp-fold-block" id="${esc(id)}" open><summary>${head}<span>tap to open</span></summary>${html}</details>${foldScript(id)}`;
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return `<script>(function(){var d=document.getElementById(${JSON.stringify(id)});if(!d)return;var k='ov_fold_'+${JSON.stringify(id)};var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>`;
}

module.exports = { pickBlock, foldBlock, foldScript };
