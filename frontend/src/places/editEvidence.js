// Preview of the edit record (修改记录) before saving: only the text added to the
// description, exactly as the backend stores it (old 123 → new 123456 records 456).
// addedText mirrors backend modules/places/services/placeEditDiff.js;
// tests/unit/places/test-edit-evidence.mjs compares the two.
import { markdownToPlainText } from '../components/markdown/markdownText.js';

// Same as backend ratingTextJudge.cleanText.
function cleanText(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) return '';
    return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

// A shared run shorter than this between two added pieces, or where old text
// around it was removed, is a coincidental match and counts as added.
export const MIN_KEPT_RUN = 4;
const EDGE_SEPARATORS = /^[\s，,、；;：:。．.！!？?…]+|[\s，,、；;：:]+$/gu;

export function addedText(before, after) {
    const a = Array.from(cleanText(before)), b = Array.from(cleanText(after));
    if (a.join('') === b.join('')) return '';
    const width = b.length + 1, dp = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
        dp[i * width + j] = a[i] === b[j] ? 1 + dp[(i + 1) * width + j + 1] : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
    const ops = [];
    const push = (op, ch) => { const last = ops[ops.length - 1]; if (last?.op === op) last.text += ch; else ops.push({ op, text: ch }); };
    for (let i = 0, j = 0; i < a.length || j < b.length;) {
        if (i < a.length && j < b.length && a[i] === b[j]) { push('=', b[j]); i++; j++; }
        else if (i < a.length && (j >= b.length || dp[(i + 1) * width + j] >= dp[i * width + j + 1])) push('-', a[i++]);
        else push('+', b[j++]);
    }
    const gap = (from, step) => {
        const found = { '+': false, '-': false };
        for (let k = from; k >= 0 && k < ops.length && ops[k].op !== '='; k += step) found[ops[k].op] = true;
        return found;
    };
    const parts = [];
    let part = '';
    ops.forEach((o, k) => {
        if (o.op === '-') return;
        if (o.op === '=') {
            const left = gap(k - 1, -1), right = gap(k + 1, 1);
            const coincidental = Array.from(o.text).length < MIN_KEPT_RUN
                && (left['+'] && right['+'] || (left['+'] || right['+']) && (left['-'] || right['-']));
            if (!coincidental) { if (part) parts.push(part); part = ''; return; }
        }
        part += o.text;
    });
    if (part) parts.push(part);
    return parts.map((p) => p.replace(EDGE_SEPARATORS, '')).filter((p) => /[\p{L}\p{N}]/u.test(p)).join(' … ').slice(0, 1000);
}

const plain = (value) => markdownToPlainText(typeof value === 'string' ? value : String(value ?? ''));

/** The comment text an edit from `before` (current place) to `after` (form) will record; '' = none. */
export function editCommentPreview(before = {}, after = {}) {
    if (after.description === undefined) return '';
    return addedText(plain(before.description), plain(after.description));
}
