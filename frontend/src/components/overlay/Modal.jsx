import React from 'react';
import ResponsivePanel from "./ResponsivePanel";

// 通用模态：宽屏居中，窄屏底部面板。open 默认为 true 以兼容旧的条件挂载写法；
// 需要退出动画时请始终渲染并通过 open 控制。
export default function Modal({ open = true, title, onClose, children, width = '80%', height = '80%' }) {
    return (
        <ResponsivePanel
            open={open}
            onClose={onClose}
            title={title}
            desktop="center"
            mobile="sheet"
            width={`min(${width}, calc(100vw - 24px))`}
            maxHeight={height}
            bodyStyle={{ padding: 16 }}
        >
            {children}
        </ResponsivePanel>
    );
}
