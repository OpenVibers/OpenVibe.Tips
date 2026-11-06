'use strict';

/**
 * A small, safe Markdown renderer for the members-only posts a creator writes.
 *
 * Everything is HTML-escaped first, so the source can never carry markup: no raw HTML, no scripts, no
 * styles, no images. What survives is the small set of marks below — headings, bold, italic, inline
 * code, fenced code, links (http/https only), bullet and numbered lists, block quotes, rules — which is
 * what a post needs and nothing more. Links get rel="noopener noreferrer nofollow".
 *
 * Headings are shifted (a post's title is the page's h3, so a Markdown "##" becomes an h4) and the
 * result is stored with the post: the HTML a member reads is the HTML the creator's Markdown rendered
 * to when they wrote it.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const PLACEHOLDER = '\u0000';

/** The inline marks of one line of text (already escaped). */
function inline(src) {
    const held = [];
    const keep = (html) => { held.push(html); return PLACEHOLDER + (held.length - 1) + PLACEHOLDER; };
    let s = escapeHtml(src);
    // Inline code first: its content is shown as it is, never as markup.
    s = s.replace(/`([^`]+)`/g, (_m, code) => keep('<code>' + code + '</code>'));
    // Links: only http and https survive; anything else stays as plain text.
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => (/^https?:\/\//i.test(url)
        ? keep('<a href="' + url + '" rel="noopener noreferrer nofollow">' + label + '</a>')
        : m));
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    return s.replace(new RegExp(PLACEHOLDER + '(\\d+)' + PLACEHOLDER, 'g'), (_m, i) => held[Number(i)]);
}

/**
 * The Markdown of a post → safe HTML.
 * @param {string} src the creator's Markdown
 * @param {object} [opts] { headingShift } how far headings move down (a post's title is an h3 on the page)
 */
function renderMarkdown(src, { headingShift = 2 } = {}) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const flushParagraph = (buf) => { if (buf.length) { out.push('<p>' + inline(buf.join(' ')) + '</p>'); buf.length = 0; } };
    const para = [];
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*```\s*$/.test(line)) {                   // a fenced code block: shown as it is, never as markup
            flushParagraph(para);
            const code = [];
            i += 1;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
            i += 1;
            out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
            continue;
        }
        if (!line.trim()) { flushParagraph(para); i += 1; continue; }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flushParagraph(para);
            const level = Math.min(6, heading[1].length + headingShift);
            out.push('<h' + level + '>' + inline(heading[2].trim()) + '</h' + level + '>');
            i += 1;
            continue;
        }
        if (/^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { flushParagraph(para); out.push('<hr>'); i += 1; continue; }
        if (/^\s*>\s?/.test(line)) {
            flushParagraph(para);
            const quote = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
            out.push('<blockquote><p>' + inline(quote.join(' ')) + '</p></blockquote>');
            continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (bullet || numbered) {
            flushParagraph(para);
            const tag = bullet ? 'ul' : 'ol';
            const items = [];
            while (i < lines.length) {
                const b = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
                const n = /^\s*\d+[.)]\s+(.*)$/.test(lines[i]);
                if (bullet && !b) break;
                if (numbered && !n) break;
                items.push((bullet ? b : n)[1]);
                i += 1;
            }
            out.push('<' + tag + '>' + items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</' + tag + '>');
            continue;
        }
        para.push(line.trim());
        i += 1;
    }
    flushParagraph(para);
    return out.join('\n');
}

module.exports = { renderMarkdown, escapeHtml };
