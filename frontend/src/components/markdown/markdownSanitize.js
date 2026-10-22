// Markdown 渲染结果插入页面前的 DOMPurify 配置：白名单只放排版用的标签与属性。
// 不允许：脚本与事件属性（DOMPurify 本身就会去掉）、style / class / id（防止盖住页面或冒充界面）、
// 表单与媒体、iframe / svg 等嵌入；链接只接受 http / https / mailto（站内相对路径也不行）。
export const MARKDOWN_SANITIZE_CONFIG = Object.freeze({
    ALLOWED_TAGS: [
        'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'abbr', 'kbd', 'code', 'pre',
        'blockquote', 'ul', 'ol', 'li', 'a', 'span', 'div',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'
    ],
    ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan', 'align', 'open'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
});

// 链接一律在新窗口打开，不带来源，也不给权重
export const MARKDOWN_LINK_REL = 'noopener noreferrer nofollow ugc';
