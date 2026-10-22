import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdownHtml } from './markdownText.js';
import { MARKDOWN_LINK_REL, MARKDOWN_SANITIZE_CONFIG } from './markdownSanitize.js';
import { isNativePlatform } from '../../platform/env';
import { openExternal } from '../../platform/navigation';
import './markdown.css';

// 显示 Markdown（含 HTML）：marked 生成 HTML，独立的 DOMPurify 实例按白名单清理后才插入页面。
let purifier = null;
function sanitize(html) {
    if (!purifier) {
        purifier = DOMPurify(window);
        purifier.addHook('afterSanitizeAttributes', (node) => {
            if (node.tagName === 'A') {
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', MARKDOWN_LINK_REL);
            }
        });
    }
    return purifier.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
}

// App 内交给系统浏览器打开（WebView 里的新窗口不可靠）；网页按链接自身的 target 打开
function handleClick(event) {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || !isNativePlatform()) return;
    event.preventDefault();
    openExternal(link.href);
}

/** 渲染 Markdown；内容为空（或清理后为空）时显示 fallback */
export default function Markdown({ text, fallback = null, style, className }) {
    const html = useMemo(() => {
        const rendered = renderMarkdownHtml(text);
        return rendered ? sanitize(rendered).trim() : '';
    }, [text]);
    if (!html) return fallback;
    return <div className={`fm-markdown${className ? ` ${className}` : ''}`} style={style} onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
