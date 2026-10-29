// 展会地点与 iOS 原生展会面板快照（纯函数，纳入 test:map）。
import { t } from '../i18n/index.js';
import { markdownToNativeInline, markdownToPlainText } from '../components/markdown/markdownText.js';

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

/** 点地址后地图上的展会图钉：key 含坐标，展会撤下或换了地点后旧图钉不再对应；label 优先用地点名。没有地点时为 null */
export function exhibitionVenue(exhibition) {
    const center = exhibitionCenter(exhibition);
    if (!center) return null;
    const label = String(exhibition.location_name || '').trim() || String(exhibition.name || '');
    return { ...center, key: `exhibition-${exhibition.id}@${center.lat},${center.lng}`, label };
}

/**
 * iOS 原生面板快照（card：两段停靠）。摘要是图标、展会名、地点与“附近随机美食”，上滑全屏看简介与信息。
 * 有坐标时副标题与地址行可点（回传 venue：收起面板、地图移到展会地点），没填地点名时副标题显示“查看位置”；
 * 没有坐标的展会地点只是文字，也不显示随机按钮。iconUrl 由调用方解析为绝对地址（原生只收 https）。
 * 简介与信息支持基础 Markdown：text 是去掉标记的纯文本（旧版 App 只认它），markdown 是原生可显示的行内格式。
 */
export function exhibitionChromeSheet(exhibition, { iconUrl } = {}) {
    if (!exhibition) return null;
    const locationName = String(exhibition.location_name || '').trim();
    const located = !!exhibitionCenter(exhibition);
    const venueAction = located ? {
        id: 'venue',
        title: locationName ? t('map:exhibition.showVenueLabel', { location: locationName }) : t('map:exhibition.showVenue'),
        symbol: 'mappin.and.ellipse'
    } : undefined;
    return {
        id: 'exhibition',
        title: exhibition.name || '',
        subtitle: locationName || (located ? t('map:exhibition.showVenue') : t('map:exhibition.subtitle')),
        subtitleAction: venueAction,
        size: 'card',
        image: iconUrl || undefined,
        caption: locationName || undefined,
        captionAction: locationName ? venueAction : undefined,
        actions: [
            located && { id: 'random', title: t('map:exhibition.randomNearby'), symbol: 'dice', tone: 'accent' },
            // 原生侧展开到全屏详情，不回传
            { id: 'details', title: t('map:ui.details'), symbol: 'info.circle', keepsOpen: true, expands: true }
        ].filter(Boolean),
        paragraphs: [
            ...(exhibition.event_time ? [{ id: 'event-time', title: t('map:exhibition.eventTime'), text: exhibition.event_time.replace('T', ' ') }] : []),
            { id: 'information', title: t('map:exhibition.information'), ...nativeParagraph(exhibition.information) },
            { id: 'description', title: t('map:exhibition.description'), ...nativeParagraph(exhibition.description) }
        ],
        sections: []
    };
}

function nativeParagraph(text) {
    return { text: markdownToPlainText(text), markdown: markdownToNativeInline(text) || undefined };
}
