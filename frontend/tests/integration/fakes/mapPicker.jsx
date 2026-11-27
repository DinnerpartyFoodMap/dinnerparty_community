import React from 'react';

// 测试替身：全屏选点地图只留两个按钮。选中时与真地图一样先回传点、再关闭。
export function FullScreenMapPicker({ open, title, context, center, onPickPoint, onClose }) {
    if (!open) return null;
    return <div role="dialog" aria-label={title} data-context={context} data-center={center ? `${center.lat},${center.lng}` : ''}>
        <button type="button" onClick={() => { onPickPoint({ lat: 31.2035, lng: 121.5732 }); onClose(); }}>选这里</button>
        <button type="button" onClick={onClose}>返回</button>
    </div>;
}
