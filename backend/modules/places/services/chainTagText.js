'use strict';

const CHAIN_TAG = '连锁店';
// Commas, ECMAScript whitespace and the legacy pipe separator are tag boundaries.
// Generate both matchers from these characters so SQLite triggers work on any connection.
const BOUNDARIES = ',，|\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const SEPARATORS = new RegExp(`([${BOUNDARIES}]+)`, 'u');

function hasChainTag(category) {
    return String(category ?? '').split(SEPARATORS).includes(CHAIN_TAG);
}

function stripChainTag(category) {
    const text = String(category ?? '');
    const parts = text.split(SEPARATORS);
    if (!parts.includes(CHAIN_TAG)) return text;
    let stripped = '';
    let separator = '';
    for (let index = 0; index < parts.length; index += 2) {
        const part = parts[index];
        if (!part || part === CHAIN_TAG) continue;
        stripped += separator + part;
        separator = parts[index + 1] || '';
    }
    return stripped;
}

function hasChainTagSql(column) {
    const normalized = [...BOUNDARIES].slice(1).reduce((sql, char) => (
        `replace(${sql}, char(${char.charCodeAt(0)}), ',')`
    ), `COALESCE(${column}, '')`);
    return `instr(',' || ${normalized} || ',', ',${CHAIN_TAG},') > 0`;
}

function chainNameKey(name) {
    let key = String(name ?? '').normalize('NFKC').toLowerCase();
    const bracketed = /\([^()]*\)|【[^【】]*】|\[[^[\]]*\]|「[^「」]*」/gu;
    for (let stripped = key.replace(bracketed, ''); stripped !== key; stripped = key.replace(bracketed, '')) {
        key = stripped;
    }
    // The separator still exists at this step. Removing it first would also erase the branch boundary.
    return key.trim().replace(/[\s\-—·]+[^\s\-—·]+店$/u, '').replace(/\s+/gu, '');
}

module.exports = { CHAIN_TAG, chainNameKey, hasChainTag, stripChainTag, hasChainTagSql };
