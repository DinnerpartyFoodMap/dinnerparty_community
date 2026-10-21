import React, { useEffect, useState } from 'react';
import { useSkinSlot } from './useSkin.js';
import { isTemplateIcon } from './slots.js';
import { skinSlot } from './skinStore.js';

// 皮肤图标：皮肤提供了这个槽位的图片时显示图片，否则原样渲染 children（原来的图标元素一个属性都不变）。
// 图片加载失败也回到原来的图标。皮肤的 iconRendering 为 template 时，功能图标按单色蒙版画成当前文字颜色，
// 浅色 / 深色模式与选中色自动跟随（与原来的字体图标一样）。
export default function SkinIcon({ slot, size = 24, style, children = null }) {
    const src = useSkinSlot(slot);
    const template = isTemplateIcon(slot, { iconRendering: skinSlot('iconRendering') });
    const [failed, setFailed] = useState('');
    const usable = typeof src === 'string' && !!src && failed !== src;

    // 蒙版没有加载失败事件：先用一张探测图确认能加载
    useEffect(() => {
        if (!usable || !template || typeof Image === 'undefined') return undefined;
        let active = true;
        const probe = new Image();
        probe.onerror = () => { if (active) setFailed(src); };
        probe.src = src;
        return () => { active = false; };
    }, [src, template, usable]);

    if (!usable) return children;
    const box = { width: size, height: size, display: 'inline-block', flexShrink: 0, ...style };
    if (template) {
        const mask = `url("${src}") center / contain no-repeat`;
        return <span className="fm-skin-icon" aria-hidden="true" style={{ ...box, backgroundColor: 'currentColor', WebkitMask: mask, mask }} />;
    }
    return (
        <img
            className="fm-skin-icon"
            src={src}
            alt=""
            aria-hidden="true"
            draggable={false}
            onError={() => setFailed(src)}
            style={{ ...box, objectFit: 'contain' }}
        />
    );
}
