// 地点描述、反馈内容的 Markdown（含 HTML）：解析交给 marked（GFM，单个换行即换行）。
// 能显示格式的地方由 Markdown.jsx 渲染：marked 生成 HTML → DOMPurify 按 markdownSanitize.js 的白名单清理 → 插入页面；
// 不能显示格式的地方（卡片摘要、搜索列表、分享卡片图等）用 markdownToPlainText 去掉标记与 HTML 标签；
// iOS 原生卡片只能显示行内样式，用 markdownToNativeInline 展开块级结构后交给 SwiftUI。
// 后端 backend/modules/places/services/markdownText.js 用同样的 marked 配置与纯文本规则（分享页、QQ 机器人），
// 改动时两边一起改；frontend tests/unit/components/test-markdown.mjs 会对照两边的输出。
import { Marked } from 'marked';

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 裸网址只取到第一个非 ASCII 字符为止：中文里“网址后面紧跟文字”很常见，GFM 默认会把后面的中文也算进链接。
// 句末的 ASCII 标点与不成对的右括号也不算。www. 开头与邮箱仍交给 marked 的默认规则。
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

const markdown = new Marked({
    gfm: true,
    breaks: true,
    tokenizer: { url: asciiUrl },
    // 图片不直接加载（任意外链图片可被用来追踪查看者），显示为指向图片的链接
    renderer: {
        image({ href, text }) {
            return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
        }
    }
});

/** Markdown → 未清理的 HTML；只能经 Markdown.jsx（DOMPurify）插入页面 */
export function renderMarkdownHtml(text) {
    return typeof text === 'string' && text.trim() ? markdown.parse(text) : '';
}

/** marked 的语法树（块级 token 列表） */
export function lexMarkdown(text) {
    return typeof text === 'string' && text ? markdown.lexer(text) : [];
}

// ---- 纯文本（后端 markdownText.js 有同样的规则） ----

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
        if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
        const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    });
}

// HTML 片段转文字：去掉注释、脚本与样式的内容，换行类标签换成换行，其余标签直接去掉
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
export function markdownToPlainText(text) {
    return plainBlocks(lexMarkdown(text)).trim();
}

// ---- iOS 原生卡片 ----

const escapeNative = (text) => text.replace(/[\\`*_~[\]<]/g, '\\$&');
// 链接地址里的括号编码掉，免得不成对的 ) 提前结束链接
const nativeHref = (href) => (/^(https?:|mailto:)/i.test(href || '') ? href.replace(/\(/g, '%28').replace(/\)/g, '%29') : null);

function nativeInline(tokens = []) {
    return tokens.map((token) => {
        switch (token.type) {
            case 'text': return token.tokens ? nativeInline(token.tokens) : escapeNative(decodeEntities(token.text));
            case 'escape': return escapeNative(token.text);
            case 'br': return '\n';
            case 'html': return escapeNative(htmlToText(token.text));
            case 'codespan': {
                if (!token.text) return '';
                const longest = Math.max(0, ...(token.text.match(/`+/g) || []).map((run) => run.length));
                const fence = '`'.repeat(longest + 1);
                const pad = token.text.startsWith('`') || token.text.endsWith('`') ? ' ' : '';
                return `${fence}${pad}${token.text}${pad}${fence}`;
            }
            case 'image':
            case 'link': {
                const label = token.type === 'image' ? escapeNative(token.text || token.href || '') : nativeInline(token.tokens);
                const href = nativeHref(token.href);
                return href && label ? `[${label}](${href})` : label;
            }
            case 'strong':
            case 'em':
            case 'del': {
                const inner = nativeInline(token.tokens);
                const mark = token.type === 'strong' ? '**' : token.type === 'del' ? '~~' : '*';
                return inner ? `${mark}${inner}${mark}` : '';
            }
            default: return token.tokens ? nativeInline(token.tokens) : '';
        }
    }).join('');
}

function nativeBlocks(tokens = [], separator = '\n\n') {
    const parts = tokens.map((token) => {
        switch (token.type) {
            case 'paragraph': return nativeInline(token.tokens);
            case 'heading': {
                const inner = nativeInline(token.tokens);
                return inner ? `**${inner}**` : '';
            }
            case 'text': return token.tokens ? nativeInline(token.tokens) : escapeNative(decodeEntities(token.text));
            case 'code': return token.text.split('\n').map(escapeNative).join('\n');
            case 'blockquote': return nativeBlocks(token.tokens);
            case 'list': return token.items.map((item, index) => `${token.ordered ? `${(Number(token.start) || 1) + index}.` : '•'} ${nativeBlocks(item.tokens, '\n')}`).join('\n');
            case 'table': return [token.header, ...token.rows].map((row) => row.map((cell) => nativeInline(cell.tokens)).join('  ')).join('\n');
            case 'hr': return '────────';
            case 'html': return escapeNative(htmlToText(token.text).trim());
            default: return '';
        }
    });
    return parts.filter(Boolean).join(separator);
}

/**
 * iOS 原生卡片用：块级结构展开（标题加粗、列表前加 • 或序号、表格按行），HTML 标签去掉，只保留行内 Markdown，
 * 其余字符全部转义，由 SwiftUI 按“只解析行内语法”显示；只保留 http(s) / mailto 链接。
 */
export function markdownToNativeInline(text) {
    return nativeBlocks(lexMarkdown(text)).trim();
}
