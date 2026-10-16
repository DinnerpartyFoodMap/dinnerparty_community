// 海外底图：高德的海外详细数据（“世界地图”）需要单独付费开通，未开通时境外放大后几乎空白。
// 这里在高德底图之上叠一层 CARTO 栅格瓦片，只覆盖完全落在高德“境内格子”之外的瓦片（见 platform/chinaRegion.js）。
// 那里高德按 WGS-84 显示，与 CARTO（OpenStreetMap 数据）一致，已有标记不用转换；境内（含港澳台）始终只显示高德。
// 瓦片由浏览器直连 CARTO：第一次需要时先试拉一张，拉不到（如大陆网络直连不通）就不再启用，用户看到的就是纯高德。
// 高德对 getTileUrl 返回 null 的瓦片不发请求也不绘制，境内瓦片因此保持原样。

import { rectTouchesAmapChinaRegion, rectWithinAmapChinaRegion } from '../platform/chinaRegion.js';
import { readViewBounds, getMapSafeInsets } from './viewport.js';
import { t } from '../i18n/index.js';

const CARTO_ORIGIN = 'https://basemaps.cartocdn.com';
const CARTO_STYLES = { light: 'rastertiles/voyager', dark: 'dark_all' };
// 高德境外在 10 级以下还有轮廓、主干道和中文地名（边界也是审过图的），从 10 级起才换成 CARTO
export const OVERSEAS_MIN_ZOOM = 10;
const OVERSEAS_MAX_ZOOM = 20;
const PROBE_TIMEOUT_MS = 6000;
// 在高德底图之上、折线等覆盖物（默认 zIndex 10）之下
const LAYER_Z_INDEX = 5;
const ATTRIBUTION_HTML = `&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> ${t('map:overseasTiles.contributors')} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a>`;

/** 瓦片（Web 墨卡托 XYZ）的经纬度范围。 */
export function tileBounds(x, y, z) {
    const n = 2 ** z;
    const lngOf = (tx) => (tx / n) * 360 - 180;
    const latOf = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
    return { west: lngOf(x), east: lngOf(x + 1), north: latOf(y), south: latOf(y + 1) };
}

/** 只有完全不碰境内格子的瓦片才由 CARTO 显示。 */
export function isOverseasTile(x, y, z) {
    const b = tileBounds(x, y, z);
    return !rectTouchesAmapChinaRegion(b.west, b.south, b.east, b.north);
}

export function buildCartoTileUrl({ x, y, z, dark, retina, apiKey }) {
    const style = dark ? CARTO_STYLES.dark : CARTO_STYLES.light;
    return `${CARTO_ORIGIN}/${style}/${z}/${x}/${y}${retina ? '@2x' : ''}.png?key=${encodeURIComponent(apiKey)}`;
}

function tileAt(lng, lat, z) {
    const n = 2 ** z;
    const rad = (lat * Math.PI) / 180;
    return {
        x: Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n))),
        y: Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n)))
    };
}

// 能否直连 CARTO 只试一次，所有地图实例共用结果
let reachability = 'unknown'; // unknown | probing | ok | failed
const reachabilityWaiters = new Set();

function probeCarto(url) {
    if (reachability !== 'unknown') return;
    reachability = 'probing';
    const img = new Image();
    let timer = null;
    const finish = (ok) => {
        if (reachability !== 'probing') return;
        window.clearTimeout(timer);
        img.onload = img.onerror = null;
        reachability = ok ? 'ok' : 'failed';
        reachabilityWaiters.forEach((notify) => notify());
    };
    timer = window.setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    img.crossOrigin = 'anonymous';
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.src = url;
}

export class OverseasTileLayer {
    /**
     * @param {any} map 高德地图实例
     * @param {{ apiKey?: string, dark?: boolean }} options apiKey 为空时什么也不做
     */
    constructor(map, { apiKey, dark = false } = {}) {
        this.map = map;
        this.apiKey = apiKey || '';
        this.dark = !!dark;
        this.visible = false;
        this.layer = null;
        this.attribution = null;
        const AMap = typeof window !== 'undefined' ? window.AMap : null;
        if (!map || !this.apiKey || !AMap?.TileLayer || reachability === 'failed') return;

        this.retina = (window.devicePixelRatio || 1) > 1;
        this.layer = new AMap.TileLayer({
            zIndex: LAYER_Z_INDEX,
            zooms: [OVERSEAS_MIN_ZOOM, OVERSEAS_MAX_ZOOM],
            getTileUrl: (x, y, z) => this.tileUrl(x, y, z)
        });
        this.layer.hide();
        map.add(this.layer);

        this.handleViewChange = () => this.update();
        map.on('moveend', this.handleViewChange);
        map.on('zoomend', this.handleViewChange);
        map.on('resize', this.handleViewChange);
        reachabilityWaiters.add(this.handleViewChange);
        this.update();
    }

    tileUrl(x, y, z) {
        if (z < OVERSEAS_MIN_ZOOM || !isOverseasTile(x, y, z)) return null;
        return buildCartoTileUrl({ x, y, z, dark: this.dark, retina: this.retina, apiKey: this.apiKey });
    }

    /** 当前视野里有没有需要 CARTO 显示的区域。 */
    viewNeedsOverseas() {
        const zoom = Number(this.map.getZoom?.());
        if (!Number.isFinite(zoom) || zoom < OVERSEAS_MIN_ZOOM) return false;
        const b = readViewBounds(this.map);
        if (!b) return false;
        return !rectWithinAmapChinaRegion(b.minLng, b.minLat, b.maxLng, b.maxLat);
    }

    update() {
        if (!this.layer) return;
        const want = reachability !== 'failed' && this.viewNeedsOverseas();
        if (want && reachability === 'unknown') {
            const tile = this.visibleOverseasTile();
            if (tile) probeCarto(this.tileUrl(tile.x, tile.y, tile.z));
        }
        this.setVisible(want && reachability === 'ok');
    }

    /** 视野中心或四角里第一块要由 CARTO 显示的瓦片，用来试探能否直连（试探成功后它已在缓存里）。 */
    visibleOverseasTile() {
        const b = readViewBounds(this.map);
        const z = Math.floor(Number(this.map.getZoom?.()));
        if (!b || !Number.isFinite(z)) return null;
        const points = [
            [(b.minLng + b.maxLng) / 2, (b.minLat + b.maxLat) / 2],
            [b.minLng, b.minLat], [b.maxLng, b.minLat], [b.minLng, b.maxLat], [b.maxLng, b.maxLat]
        ];
        for (const [lng, lat] of points) {
            const t = tileAt(lng, lat, z);
            if (isOverseasTile(t.x, t.y, z)) return { ...t, z };
        }
        return null;
    }

    setVisible(visible) {
        if (visible) this.placeAttribution();
        if (visible === this.visible) return;
        this.visible = visible;
        if (visible) this.layer.show();
        else this.layer.hide();
        if (this.attribution) this.attribution.style.display = visible ? '' : 'none';
    }

    /** CARTO 与 OSM 要求署名始终可见：放在地图右下角，避开底部工具栏等遮挡。 */
    placeAttribution() {
        const container = this.map.getContainer?.();
        if (!container) return;
        if (!this.attribution) {
            const el = document.createElement('div');
            el.className = 'overseas-attribution';
            el.innerHTML = ATTRIBUTION_HTML;
            el.style.cssText = 'position:absolute;right:4px;z-index:150;padding:1px 6px;border-radius:4px;font-size:10px;line-height:16px;pointer-events:auto;white-space:nowrap;';
            container.appendChild(el);
            this.attribution = el;
            this.applyAttributionTheme();
        }
        const insets = getMapSafeInsets(container);
        this.attribution.style.bottom = `calc(${Math.round(insets.bottom)}px + env(safe-area-inset-bottom, 0px) + 2px)`;
    }

    applyAttributionTheme() {
        if (!this.attribution) return;
        this.attribution.style.background = this.dark ? 'rgba(20, 20, 24, 0.6)' : 'rgba(255, 255, 255, 0.7)';
        this.attribution.style.color = this.dark ? 'rgba(235, 235, 240, 0.85)' : 'rgba(40, 40, 48, 0.85)';
        for (const link of this.attribution.querySelectorAll('a')) link.style.color = 'inherit';
    }

    setDark(dark) {
        if (!this.layer || !!dark === this.dark) return;
        this.dark = !!dark;
        this.applyAttributionTheme();
        this.layer.reload();
    }

    destroy() {
        if (!this.layer) return;
        reachabilityWaiters.delete(this.handleViewChange);
        try {
            this.map.off('moveend', this.handleViewChange);
            this.map.off('zoomend', this.handleViewChange);
            this.map.off('resize', this.handleViewChange);
            this.map.remove(this.layer);
        } catch (e) { /* 地图可能已销毁 */ }
        if (this.attribution) this.attribution.remove();
        this.layer = null;
        this.attribution = null;
    }
}
