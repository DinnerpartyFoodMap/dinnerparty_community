// iOS 原生底图的标记层：与 MarkerLayerController 同一个入口（update / setSelectedKey / refreshAppearance / destroy），
// 但不在网页里画任何东西。地点、聚合点与名称都由 MapKit 的标注视图显示，拖动缩放时与底图同帧移动；
// 聚合由 MapKit 按碰撞框完成（碰撞框边长取网页的聚合半径 CLUSTER_DEFAULTS.radiusPx）。
// 网页只在数据或外观变化时下发：地点列表（id、坐标、名称、图标种类）与样式（图片、颜色、读屏文案）。
import { normalizePlaces, CLUSTER_DEFAULTS } from './cluster/engine.js';
import { PLACE_GLYPH, CLUSTER_GLYPH } from './cluster/glyph.js';
import { placeGlyphKind, markerImageSources, DEFAULT_CLUSTER_CROP } from './markerContent.js';
import { nativeImageSource } from '../skins/nativeSkin.js';
import { nativeColor } from '../platform/nativeMap.js';
import { t } from '../i18n/index.js';

function cssVar(name) {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) {
        return '';
    }
}

function percent(value, fallback) {
    const number = parseFloat(value);
    return Number.isFinite(number) && /%\s*$/.test(String(value)) ? Math.min(1, Math.max(0, number / 100)) : fallback;
}

/**
 * 原生标记的样式：与 marker-motion.css 同一套取值（皮肤槽位的 CSS 变量优先，否则用设计令牌），
 * 按当前主题色与深浅色算好；图片只给原生能直接读的地址（App 包内资源或位图 data URL，SVG 皮肤图退回默认图）。
 */
export function buildNativeMarkerStyle({ readVar = cssVar, sources = markerImageSources(), imageSource = nativeImageSource } = {}) {
    const image = (entry) => imageSource(entry.src) || imageSource(entry.fallback);
    const skinCluster = !sources.cluster.isDefault && imageSource(sources.cluster.src);
    const color = (...names) => {
        for (const name of names) {
            const value = nativeColor(readVar(name));
            if (value) return value;
        }
        return undefined;
    };
    return {
        glyphs: {
            place: image(sources.place),
            avoid: image(sources.avoid),
            unexplored: image(sources.unexplored),
            add: image(sources.add)
        },
        glyphWidth: PLACE_GLYPH.width,
        glyphHeight: PLACE_GLYPH.height,
        clusterImage: skinCluster || imageSource(sources.cluster.fallback),
        // 默认聚合图裁去透明留白（与网页相同），皮肤图用整张画布
        clusterCrop: skinCluster ? undefined : [DEFAULT_CLUSTER_CROP.x, DEFAULT_CLUSTER_CROP.y, DEFAULT_CLUSTER_CROP.width, DEFAULT_CLUSTER_CROP.height],
        clusterWidth: CLUSTER_GLYPH.width,
        clusterHeight: CLUSTER_GLYPH.height,
        countX: percent(readVar('--skin-marker-count-x'), skinCluster ? 0.54 : 0.5),
        countY: percent(readVar('--skin-marker-count-y'), skinCluster ? 0.3 : 0.35),
        countColor: color('--skin-marker-count-color', '--color-on-emphasis'),
        labelText: color('--skin-marker-label-color', '--color-text-primary'),
        labelBackground: color('--skin-marker-label-bg', '--color-bg-surface'),
        labelBorder: color('--skin-marker-label-border', '--theme-primary'),
        avoidText: color('--color-danger-text', '--color-danger'),
        avoidBackground: color('--color-bg-overlay'),
        avoidBorder: color('--color-danger'),
        collisionSize: CLUSTER_DEFAULTS.radiusPx,
        kindSuffix: {
            avoid: t('map:marker.avoidSuffix'),
            unexplored: t('map:marker.unexploredSuffix'),
            add: t('map:marker.unmarkedSuffix')
        },
        clusterLabel: t('map:marker.clusterLabel', { count: '%d' })
    };
}

/** 当前模式的地点 → 原生标记（key 作为原生 id，图标种类同网页 placeGlyphKind） */
export function nativeMarkerEntries(places) {
    return normalizePlaces(places).map(({ key, lng, lat, place }) => ({
        id: key,
        lng,
        lat,
        name: String(place.name || ''),
        kind: placeGlyphKind(place),
        place
    }));
}

export class NativeMarkerLayer {
    /**
     * @param {import('./nativeMapView.js').NativeMapView} map
     * @param {{ onPlaceClick?: (place: object) => void,
     *           onClusterMembers?: (members: { key: string, coordinate: [number, number], places: object[] }) => void }} options
     */
    constructor(map, options = {}) {
        this.map = map;
        this.options = options;
        this.placeByKey = new Map();
        this.selectedKey = null;
        this.signature = '';
        this.styleKey = '';
        this.destroyed = false;
        this._onMarkerTap = ({ id }) => {
            const place = this.placeByKey.get(id);
            if (place) this.options.onPlaceClick?.(place);
        };
        this._onClusterMembers = ({ ids, lng, lat }) => {
            const places = (Array.isArray(ids) ? ids : []).map((id) => this.placeByKey.get(id)).filter(Boolean);
            if (places.length) this.options.onClusterMembers?.({ key: `cluster:${ids.slice().sort().join(',')}`, coordinate: [Number(lng), Number(lat)], places });
        };
        map.on('markerTap', this._onMarkerTap);
        map.on('clusterMembers', this._onClusterMembers);
        // 主题色、深浅色、皮肤变化：重新下发样式（网页标记靠 CSS 变量自动更新，原生要显式下发）
        this._onTheme = () => this._scheduleStyle();
        window.addEventListener('themechange', this._onTheme);
        this.themeObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(this._onTheme) : null;
        this.themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'data-skin', 'class'] });
        this.styleTimer = 0;
        this.refreshAppearance();
    }

    update({ places = [] } = {}) {
        if (this.destroyed) return;
        const entries = nativeMarkerEntries(places);
        this.placeByKey = new Map(entries.map((entry) => [entry.id, entry.place]));
        // 只有 id、坐标、名称、图标种类变化才下发（评价、收藏等其他字段不影响标记）
        const signature = entries.map((entry) => `${entry.id}|${entry.lng}|${entry.lat}|${entry.kind}|${entry.name}`).join('\n');
        if (signature === this.signature) return;
        this.signature = signature;
        this.map.setPlaces(entries, this.selectedKey);
    }

    setSelectedKey(key) {
        const next = key || null;
        if (next === this.selectedKey) return;
        this.selectedKey = next;
        this.map.setSelectedPlace(next);
    }

    /** 皮肤、主题变化后重新下发样式（不重发地点） */
    refreshAppearance() {
        if (this.destroyed) return;
        const style = buildNativeMarkerStyle();
        const key = JSON.stringify(style);
        if (key === this.styleKey) return;
        this.styleKey = key;
        this.map.setMarkerStyle(style);
    }

    _scheduleStyle() {
        window.clearTimeout(this.styleTimer);
        this.styleTimer = window.setTimeout(() => this.refreshAppearance(), 50);
    }

    setNativeGlassVisible() { }

    /** MapView 的聚合展开在原生里完成，不需要网页的聚合引擎 */
    getEngine() {
        return null;
    }

    getDataBounds() {
        let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
        for (const place of this.placeByKey.values()) {
            const lng = Number(place.longitude), lat = Number(place.latitude);
            minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        }
        return this.placeByKey.size ? { minLng, minLat, maxLng, maxLat } : null;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        window.clearTimeout(this.styleTimer);
        window.removeEventListener('themechange', this._onTheme);
        this.themeObserver?.disconnect();
        this.map.off('markerTap', this._onMarkerTap);
        this.map.off('clusterMembers', this._onClusterMembers);
    }
}
