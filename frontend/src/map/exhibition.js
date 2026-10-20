// 展会地点与 iOS 原生展会面板快照（纯函数，纳入 test:map）。
import { t } from '../i18n/index.js';

/** 展会地点（GCJ-02，与地点相同）；未设置或无效时为 null */
export function exhibitionCenter(exhibition) {
    if (!exhibition || exhibition.latitude == null || exhibition.longitude == null
        || exhibition.latitude === '' || exhibition.longitude === '') return null;
    const lat = Number(exhibition.latitude);
    const lng = Number(exhibition.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    return { lat, lng };
}

/** 随机美食的固定中心：展会地点。key 区分不同展会，label 用于面板文案；没有地点时为 null */
export function exhibitionRandomOrigin(exhibition) {
    const center = exhibitionCenter(exhibition);
    return center ? { ...center, key: `exhibition-${exhibition.id}`, label: String(exhibition.name || '') } : null;
}

/**
 * iOS 原生面板快照（card：两段停靠）。摘要是图标、展会名、地点与“附近随机美食”，上滑全屏看简介与信息。
 * 没有地点的展会不显示随机按钮。iconUrl 由调用方解析为绝对地址（原生只收 https）。
 */
export function exhibitionChromeSheet(exhibition, { iconUrl } = {}) {
    if (!exhibition) return null;
    const locationName = String(exhibition.location_name || '').trim();
    return {
        id: 'exhibition',
        title: exhibition.name || '',
        subtitle: locationName || t('map:exhibition.subtitle'),
        size: 'card',
        image: iconUrl || undefined,
        caption: locationName || undefined,
        actions: [
            exhibitionRandomOrigin(exhibition) && { id: 'random', title: t('map:exhibition.randomNearby'), symbol: 'dice', tone: 'accent' },
            // 原生侧展开到全屏详情，不回传
            { id: 'details', title: t('map:ui.details'), symbol: 'info.circle', keepsOpen: true, expands: true }
        ].filter(Boolean),
        paragraphs: [
            { id: 'description', title: t('map:exhibition.description'), text: exhibition.description },
            { id: 'information', title: t('map:exhibition.information'), text: exhibition.information }
        ],
        sections: []
    };
}
