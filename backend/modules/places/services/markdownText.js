// 地点描述的 Markdown（含 HTML）转纯文字：分享页卡片与正文、QQ 机器人消息等不能显示格式的地方。
// 解析用 marked，配置与纯文本规则和前端 frontend/src/components/markdown/markdownText.js 相同，改动时两边一起改；
// frontend tests/unit/components/test-markdown.mjs 会对照两边的输出。
// 结果可能含 <、& 等字符：输出到 HTML 时由调用方转义（placeShare 的 htmlEscape）。
const logger = require('../../../infrastructure/logger');

// marked 18 只提供 ES 模块：Node 22.12 起可以直接 require。更旧的 Node 加载失败时退回只去标签与常见标记，不影响启动。
let markdown = null;
try {
    const { Marked } = require('marked');
    markdown = new Marked({ gfm: true, breaks: true, tokenizer: { url: asciiUrl } });
} catch (error) {
    logger.warn('Markdown parser unavailable; falling back to tag stripping', { event: 'markdown.unavailable', error: error.message });
}

// 与前端相同：裸网址只取到第一个非 ASCII 字符为止（只影响链接范围，不影响纯文字内容）
function asciiUrl(src) {
    const match = /^https?:\/\/[\x21-\x3B\x3D\x3F-\x7E]+/i.exec(src);
    if (!match) return false;
    let url = match[0];
    for (;;) {
        const trimmed = url.replace(/[?!.,:;*_'"~]+$/, '');
        const unbalanced = trimmed.endsWith(')') && (trimmed.match(/\(/g) || []).length < (trimmed.match(/\)/g) || []).length;
        const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
        if (next === url) break;
        url = next;
    }
    if (!/^https?:\/\/[^/]/i.test(url)) return false;
    return { type: 'link', raw: url, text: url, href: url, tokens: [{ type: 'text', raw: url, text: url, escaped: false }] };
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
        if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
        const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    });
}

function htmlToText(html) {
    return decodeEntities(String(html)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|table|ul|ol)\s*>/gi, '\n')
        .replace(/<\/?[a-z][^>]*>/gi, ''));
}

function plainInline(tokens = []) {
    return tokens.map((token) => {
        switch (token.type) {
            case 'text': return token.tokens ? plainInline(token.tokens) : decodeEntities(token.text);
            case 'escape':
            case 'codespan': return token.text;
            case 'br': return '\n';
            case 'html': return htmlToText(token.text);
            case 'image': return token.text;
            default: return token.tokens ? plainInline(token.tokens) : '';
        }
    }).join('');
}

function plainBlocks(tokens = []) {
    const parts = tokens.map((token) => {
        switch (token.type) {
            case 'paragraph':
            case 'heading': return plainInline(token.tokens);
            case 'text': return token.tokens ? plainInline(token.tokens) : decodeEntities(token.text);
            case 'code': return token.text;
            case 'blockquote': return plainBlocks(token.tokens);
            case 'list': return token.items.map((item, index) => (token.ordered ? `${(Number(token.start) || 1) + index}. ` : '') + plainBlocks(item.tokens)).join('\n');
            case 'table': return [token.header, ...token.rows].map((row) => row.map((cell) => plainInline(cell.tokens)).join(' ')).join('\n');
            case 'html': return htmlToText(token.text);
            default: return '';
        }
    });
    return parts.map((part) => part.trim()).filter(Boolean).join('\n');
}

/** 去掉 Markdown 标记与 HTML 标签后的纯文字（保留换行；有序列表保留序号，链接只留文字） */
function markdownToPlainText(text) {
    if (typeof text !== 'string' || !text) return '';
    if (!markdown) return htmlToText(text).replace(/[*_~`#>]+/g, '').trim();
    return plainBlocks(markdown.lexer(text)).trim();
}

module.exports = { markdownToPlainText };
