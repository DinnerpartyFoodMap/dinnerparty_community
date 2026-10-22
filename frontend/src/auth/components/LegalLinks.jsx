import React from 'react';
import { isNativePlatform } from '../../platform/env.js';
import { openExternal } from '../../platform/navigation.js';
import { legalPageTitle, legalPageUrl } from '../legalPages.js';

/** 单个政策链接：网页在新窗口打开，App 交给系统浏览器，不丢失当前表单和编辑状态 */
export function LegalLink({ page, style, onOpen }) {
    const native = isNativePlatform();
    const href = legalPageUrl(page);
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" style={style}
            onClick={(event) => {
                onOpen?.();
                if (!native) return;
                event.preventDefault();
                void openExternal(href);
            }}>
            {legalPageTitle(page)}
        </a>
    );
}

/** 用户协议 · 隐私权政策 */
export default function LegalLinks({ style, linkStyle, onOpen }) {
    return (
        <span style={style}>
            <LegalLink page="terms" style={linkStyle} onOpen={onOpen} />
            <span aria-hidden="true" style={{ margin: '0 6px', opacity: 0.55 }}>·</span>
            <LegalLink page="privacy" style={linkStyle} onOpen={onOpen} />
        </span>
    );
}
