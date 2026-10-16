// 安卓 App（Chromium WebView）上的玻璃边缘折射。
// 为每块玻璃按尺寸与圆角生成一张位移贴图（圆角矩形的距离场：边缘一圈指向内侧、越靠边位移越大，中间不动），
// 经 SVG feDisplacementMap 写进 backdrop-filter（CSS 变量 --glass-refraction），背后的地图在边缘像透过凸透镜一样弯折。
// WebKit 不渲染 backdrop-filter 里的 SVG 滤镜，所以 iOS 不启用；网页版不使用玻璃材质。
//
// 致谢：本文件为独立实现（未复制以下项目的代码），技术路线参考：
// - deepika-builds/liquid-glass（MIT）https://github.com/deepika-builds/liquid-glass
//   feImage 载入位移贴图 + feDisplacementMap 写进 backdrop-filter、滤镜区域与 color-interpolation-filters="sRGB" 的设置
// - Amir-Abushanab/liquid-glass-js https://github.com/Amir-Abushanab/liquid-glass-js
// - samasante/liquid-glass（MIT）https://github.com/samasante/liquid-glass ：圆角矩形距离场生成位移贴图的思路
// 降级（掉帧）与减少透明度时，overlay.css 直接去掉 backdrop-filter，这里不用另行处理。

const GLASS_SELECTOR = '.fm-surface, .fm-glass, .fm-search-results, .fm-map-search__input, .fm-map-search__submit, .fm-map-toolbar';
const SVG_NS = 'http://www.w3.org/2000/svg';
// 贴图生成与 PNG 编码是 O(面积)：超大的玻璃不生成，只保留模糊
const MAX_SIDE = 1200;
const MIN_SIDE = 24;
const MAX_FILTERS = 40;

let started = false;
let defs = null;
let seq = 0;
let scanFrame = 0;
let resizeObserver = null;
/** 尺寸键（宽x高r圆角）→ { id, node, users } */
const filters = new Map();
/** 玻璃元素 → 当前使用的尺寸键（null 表示不折射） */
const tracked = new Map();

/** 浏览器是否接受 backdrop-filter 里的 SVG 滤镜（Chromium）。调用方负责只在安卓 App 内启用。 */
export function supportsBackdropRefraction() {
    try {
        return typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#a) blur(1px)');
    } catch (e) {
        return false;
    }
}

export function startGlassRefraction() {
    if (started || typeof document === 'undefined' || !document.body) return;
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined' || !supportsBackdropRefraction()) return;
    started = true;
    resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) update(entry.target);
    });
    // 弹窗、菜单、提示随时挂载卸载：同一帧内的变化合并为一次扫描
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scheduleScan();
}

function scheduleScan() {
    if (scanFrame) return;
    scanFrame = requestAnimationFrame(scan);
}

function scan() {
    scanFrame = 0;
    for (const el of Array.from(tracked.keys())) {
        if (!el.isConnected) untrack(el);
    }
    for (const el of document.querySelectorAll(GLASS_SELECTOR)) {
        if (tracked.has(el)) continue;
        tracked.set(el, null);
        // 开始观察时会立即回调一次，首张贴图在那里生成
        resizeObserver.observe(el);
    }
}

function untrack(el) {
    resizeObserver.unobserve(el);
    release(tracked.get(el), el);
    tracked.delete(el);
    el.style.removeProperty('--glass-refraction');
}

function update(el) {
    if (!el.isConnected) {
        untrack(el);
        return;
    }
    // offsetWidth/Height 是布局尺寸，不受进出场缩放动画影响
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let key = null;
    let radius = 0;
    if (w >= MIN_SIDE && h >= MIN_SIDE && w <= MAX_SIDE && h <= MAX_SIDE) {
        radius = readRadius(el, w, h);
        key = `${w}x${h}r${radius}`;
    }
    const previous = tracked.get(el);
    if (previous === key) return;
    release(previous, el);
    tracked.set(el, key);
    if (!key) {
        el.style.removeProperty('--glass-refraction');
        return;
    }
    const entry = acquire(key, w, h, radius);
    entry.users.add(el);
    el.style.setProperty('--glass-refraction', `url(#${entry.id})`);
}

function readRadius(el, w, h) {
    const raw = getComputedStyle(el).borderTopLeftRadius || '0';
    const value = parseFloat(raw) || 0;
    const px = raw.trim().endsWith('%') ? value / 100 * Math.min(w, h) : value;
    return Math.round(Math.max(0, Math.min(px, w / 2, h / 2)));
}

function release(key, el) {
    if (!key) return;
    const entry = filters.get(key);
    if (entry) entry.users.delete(el);
}

function ensureDefs() {
    if (defs && defs.isConnected) return defs;
    // 不能用 display: none：Chromium 里隐藏的 SVG 中的滤镜会失效
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
}

function acquire(key, w, h, radius) {
    const existing = filters.get(key);
    if (existing) return existing;
    if (filters.size >= MAX_FILTERS) {
        for (const [oldKey, entry] of filters) {
            if (entry.users.size === 0) {
                entry.node.remove();
                filters.delete(oldKey);
            }
        }
    }
    const map = buildDisplacementMap(w, h, radius);
    const id = `fm-glass-refraction-${++seq}`;
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    // 必须是 sRGB：默认的 linearRGB 会把贴图的中性灰映射偏，整块玻璃产生一个固定偏移
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const image = document.createElementNS(SVG_NS, 'feImage');
    image.setAttribute('href', map.url);
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(w));
    image.setAttribute('height', String(h));
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('result', 'map');
    const displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
    displace.setAttribute('in', 'SourceGraphic');
    displace.setAttribute('in2', 'map');
    displace.setAttribute('scale', String(map.scale));
    displace.setAttribute('xChannelSelector', 'R');
    displace.setAttribute('yChannelSelector', 'G');
    filter.appendChild(image);
    filter.appendChild(displace);
    ensureDefs().appendChild(filter);
    const entry = { id, node: filter, users: new Set() };
    filters.set(key, entry);
    return entry;
}

/**
 * 位移贴图：R、G 两个通道分别是 x、y 方向的位移，128 为不动。
 * 边缘一圈（宽 bezel）取样点向内移动，剖面为圆弧（越靠边越陡），像凸透镜的弧形边缘把内侧的内容拉向边缘；中间区域不动。
 */
export function buildDisplacementMap(w, h, radius) {
    const bezel = Math.max(6, Math.min(18, Math.round(Math.min(w, h) * 0.26)));
    const shift = bezel * 0.8;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(w, h);
    const data = image.data;
    const hw = w / 2;
    const hh = h / 2;
    const r = Math.min(radius, hw, hh);
    for (let y = 0; y < h; y++) {
        const py = y + 0.5 - hh;
        const ay = Math.abs(py);
        const sy = py < 0 ? -1 : 1;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const px = x + 0.5 - hw;
            const ax = Math.abs(px);
            const qx = ax - (hw - r);
            const qy = ay - (hh - r);
            // 到边缘的距离与向外的法线
            let dist;
            let nx = 0;
            let ny = 0;
            if (qx > 0 && qy > 0) {
                const len = Math.hypot(qx, qy);
                dist = r - len;
                if (len > 0) {
                    nx = (qx / len) * (px < 0 ? -1 : 1);
                    ny = (qy / len) * sy;
                }
            } else if (qx > qy) {
                dist = hw - ax;
                nx = px < 0 ? -1 : 1;
            } else {
                dist = hh - ay;
                ny = sy;
            }
            let dx = 0;
            let dy = 0;
            if (dist >= 0 && dist < bezel) {
                const t = 1 - dist / bezel;
                const magnitude = 1 - Math.sqrt(1 - t * t);
                dx = -nx * magnitude;
                dy = -ny * magnitude;
            }
            data[i] = 128 + Math.round(127 * dx);
            data[i + 1] = 128 + Math.round(127 * dy);
            data[i + 2] = 128;
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    // feDisplacementMap：位移 = scale × (通道值 − 0.5)，通道 ±127 对应 ±shift
    return { url: canvas.toDataURL('image/png'), scale: Math.round(shift * 2 * 255 / 254 * 10) / 10 };
}
