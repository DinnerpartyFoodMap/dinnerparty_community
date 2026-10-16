// 地图视口工具：读取范围、投影、Web Mercator 像素换算，以及地图被界面遮挡的安全区域。

import { AMAP_TILE_SIZE } from './cluster/engine.js';

function readLngLat(point) {
    if (!point) return null;
    const lng = typeof point.getLng === 'function' ? point.getLng() : (point.lng ?? point[0]);
    const lat = typeof point.getLat === 'function' ? point.getLat() : (point.lat ?? point[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

export function readViewBounds(map) {
    try {
        const bounds = map?.getBounds?.();
        if (!bounds) return null;
        const sw = readLngLat(bounds.getSouthWest?.() ?? bounds.southWest);
        const ne = readLngLat(bounds.getNorthEast?.() ?? bounds.northEast);
        if (!sw || !ne) return null;
        return { minLng: sw.lng, minLat: sw.lat, maxLng: ne.lng, maxLat: ne.lat };
    } catch (e) {
        return null;
    }
}

export function getMapZoomRange(map) {
    try {
        const zooms = map?.getZooms?.();
        if (Array.isArray(zooms) && Number.isFinite(zooms[0]) && Number.isFinite(zooms[1])) {
            return { min: zooms[0], max: zooms[1] };
        }
    } catch (e) { /* ignore */ }
    return { min: 2, max: 20 };
}

export function projectToContainer(map, coordinate) {
    if (!map || !coordinate) return null;
    try {
        const fn = map.lngLatToContainer || map.lnglatToContainer;
        if (typeof fn !== 'function') return null;
        const p = fn.call(map, coordinate);
        if (!p) return null;
        const x = typeof p.getX === 'function' ? p.getX() : p.x;
        const y = typeof p.getY === 'function' ? p.getY() : p.y;
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch (e) {
        return null;
    }
}

export function worldPixel(lng, lat, zoom) {
    const size = AMAP_TILE_SIZE * Math.pow(2, zoom);
    const sin = Math.sin(lat * Math.PI / 180);
    const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    return { x: (lng / 360 + 0.5) * size, y: y * size };
}

export function unprojectWorldPixel(x, y, zoom) {
    const size = AMAP_TILE_SIZE * Math.pow(2, zoom);
    const lng = (x / size - 0.5) * 360;
    const y2 = (180 - (y / size) * 360) * Math.PI / 180;
    const lat = 360 * Math.atan(Math.exp(y2)) / Math.PI - 90;
    return { lng, lat };
}

/**
 * 求地图中心，使 (lng, lat) 在缩放 zoom 下落在容器内的 (targetX, targetY) 处。
 * 用于把点击的聚合放到未被工具栏、搜索框遮挡的区域中央。
 */
export function centerForScreenTarget({ lng, lat, zoom, targetX, targetY, width, height }) {
    const p = worldPixel(lng, lat, zoom);
    const center = unprojectWorldPixel(p.x - (targetX - width / 2), p.y - (targetY - height / 2), zoom);
    return [center.lng, center.lat];
}

// ---- 安全区域：DOM 中标记了 data-map-occluder 的界面元素，以及原生控件回传的占用区域 ----

const nativeOccupiedRects = new Map();

/** 原生控件层回传的占用区域（窗口 CSS 像素）。传 null 清除。 */
export function setNativeOccupiedRects(owner, rects) {
    if (!rects || !rects.length) nativeOccupiedRects.delete(owner);
    else nativeOccupiedRects.set(owner, rects.map((r) => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height })));
}

export function getMapSafeInsets(container) {
    const insets = { top: 0, right: 0, bottom: 0, left: 0 };
    if (!container || typeof container.getBoundingClientRect !== 'function') return insets;
    const box = container.getBoundingClientRect();
    if (!box.width || !box.height) return insets;
    const rects = [];
    for (const el of document.querySelectorAll('[data-map-occluder]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) rects.push(r);
    }
    for (const list of nativeOccupiedRects.values()) rects.push(...list);
    for (const r of rects) {
        if (r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
        // 横跨大半宽度的元素视为顶部/底部条；其余窄元素（浮动按钮列）不收缩可用区域
        if (r.right - r.left < box.width * 0.5) continue;
        const centerY = (r.top + r.bottom) / 2;
        if (centerY < box.top + box.height / 2) insets.top = Math.max(insets.top, r.bottom - box.top);
        else insets.bottom = Math.max(insets.bottom, box.bottom - r.top);
    }
    insets.top = Math.min(insets.top, box.height * 0.45);
    insets.bottom = Math.min(insets.bottom, box.height * 0.45);
    return insets;
}
