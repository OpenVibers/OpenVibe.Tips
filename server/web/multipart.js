'use strict';

/**
 * A small multipart/form-data reader for the one upload form (a creator's sound): text fields and at most one file,
 * from a body already read in full and bounded by the route (express.raw with a limit). Returns null for anything
 * that is not well-formed multipart, so a broken or forged body is refused rather than half-read.
 *
 *   parse(buffer, contentType) → { fields: { name: value }, file: { field, filename, type, data } | null } | null
 */
const MAX_PARTS = 16;

function boundaryOf(contentType) {
    const m = /^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(String(contentType || ''));
    return m ? (m[1] || m[2]) : null;
}

function headerParams(value) {
    const out = {};
    const re = /;\s*([a-z*]+)="((?:[^"\\]|\\.)*)"/gi;
    let m;
    while ((m = re.exec(value))) out[m[1].toLowerCase()] = m[2].replace(/\\(.)/g, '$1');
    return out;
}

function parse(buf, contentType) {
    const boundary = boundaryOf(contentType);
    if (!boundary || !Buffer.isBuffer(buf)) return null;
    const delim = Buffer.from(`--${boundary}`);
    let pos = buf.indexOf(delim);
    if (pos !== 0) return null;
    const fields = {};
    let file = null;
    let parts = 0;
    for (;;) {
        pos += delim.length;
        if (buf.slice(pos, pos + 2).toString('latin1') === '--') return { fields, file };   // the closing delimiter
        if (buf.slice(pos, pos + 2).toString('latin1') !== '\r\n') return null;
        pos += 2;
        if (++parts > MAX_PARTS) return null;
        const headEnd = buf.indexOf('\r\n\r\n', pos, 'latin1');
        if (headEnd < 0) return null;
        const headers = {};
        for (const line of buf.slice(pos, headEnd).toString('utf8').split('\r\n')) {
            const i = line.indexOf(':');
            if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const next = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
        if (next < 0) return null;
        const body = buf.slice(headEnd + 4, next);
        const disp = headers['content-disposition'] || '';
        if (!/^form-data\b/i.test(disp)) return null;
        const p = headerParams(disp);
        if (!p.name) return null;
        if (p.filename !== undefined) {
            if (file) return null;   // one file per upload
            file = { field: p.name, filename: p.filename, type: headers['content-type'] || null, data: Buffer.from(body) };
        } else {
            fields[p.name] = body.toString('utf8');
        }
        pos = next + 2;   // past the CRLF, onto the delimiter
    }
}

module.exports = { parse, boundaryOf };
