import React from 'react';
import { useSkinSlot } from './useSkin.js';

/** 账号入口的默认头像：皮肤有默认头像时用它，否则用传入的原默认头像。住民自己的头像不受影响。 */
export function useSkinDefaultAvatar(fallback) {
    const avatar = useSkinSlot('account.defaultAvatar');
    return typeof avatar === 'string' && avatar ? avatar : fallback;
}

// 头像框：皮肤有头像框时在头像外套一层装饰（比头像大 scale 倍，居中），否则原样渲染 children。
// size 为数字时按像素排版；不传时撑满父元素（iOS 工具栏右侧的头像圆钮）。
export default function SkinAvatarFrame({ size, children }) {
    const frame = useSkinSlot('account.avatarFrame');
    if (!frame) return children;
    const spread = `${((frame.scale - 1) / 2) * 100}%`;
    const box = typeof size === 'number'
        ? { width: size, height: size, display: 'inline-flex', flexShrink: 0 }
        : { width: '100%', height: '100%', display: 'block' };
    return (
        <span className="fm-skin-avatar" style={{ position: 'relative', ...box }}>
            {children}
            <span
                aria-hidden="true"
                className="fm-skin-avatar__frame"
                style={{
                    position: 'absolute', left: `-${spread}`, top: `-${spread}`, right: `-${spread}`, bottom: `-${spread}`,
                    backgroundImage: `url("${frame.image}")`, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat', pointerEvents: 'none'
                }}
            />
        </span>
    );
}
