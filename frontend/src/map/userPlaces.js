// 按住民筛选（地点卡片点“最近修改”的名字）：卡片上的住民、列表文案与操作、iOS 原生列表面板快照（纯函数，纳入 test:map）。
// 筛选状态由 MapView 持有：{ user: { id, name }, status: 'loading'|'ready'|'error', places, total, relation, error }，
// relation 来自 GET /users/:id/places（self：就是自己；blocked：为以后的屏蔽功能预留，目前恒为 false）。
import { t } from '../i18n/index.js';
import { isAvoidedPlace } from '../places/rating.js';

/**
 * 日期只保留到日（本地时区）。SQLite 的 CURRENT_TIMESTAMP 是不带时区的 UTC（"2026-08-08 10:00:00"），
 * 按 UTC 解析；Safari 不认空格分隔的写法，所以先改成 ISO。无效时为 null。
 */
export function formatPlaceDay(raw) {
    if (raw == null || raw === '') return null;
    const text = String(raw).trim();
    const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
    const date = /^\d+$/.test(text) ? new Date(Number(text)) : new Date(sqliteUtc ? `${text.replace(' ', 'T')}Z` : text);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 地点卡片的“最近修改”：修改过的是最后修改人，否则是创建者。
 * name 为空表示账号已注销（只有 id），此时 clickable 为假；高德临时地点没有这一行（null）。
 */
export function lastModifierOf(place) {
    if (!place || place.isMarked === false) return null;
    const modified = place.updated_by != null && place.updated_by !== '';
    const id = modified ? place.updated_by : place.creator_id;
    const name = (modified ? place.updated_by_name : place.creator_name) || null;
    const date = formatPlaceDay(modified ? (place.updated_time || place.created_time) : place.created_time);
    return { id: id ?? null, name, date, clickable: !!(id && name) };
}

/** 卡片上的文字：“九日缤 · 2026-08-08”；注销的住民显示为“已注销的住民” */
export function lastModifierText(modifier) {
    if (!modifier) return '-';
    return `${modifier.name || (modifier.id ? t('map:userPlaces.deletedUser') : '-')} · ${modifier.date || '-'}`;
}

export function userPlacesTitle(filter) {
    if (!filter) return '';
    return filter.relation?.self ? t('map:userPlaces.titleSelf') : t('map:userPlaces.title', { name: filter.user.name });
}

/** 列表上方的说明（数量、排序、是否只显示了最近的一部分）；加载中 / 出错时为空 */
export function userPlacesSummary(filter) {
    if (!filter || filter.status !== 'ready' || !filter.total) return '';
    return filter.total > filter.places.length
        ? t('map:userPlaces.summaryLimited', { total: filter.total, limit: filter.places.length })
        : t('map:userPlaces.summary', { total: filter.total });
}

/** 加载中 / 出错 / 没有地点时代替列表的提示；有地点时为空 */
export function userPlacesMessage(filter) {
    if (!filter) return '';
    if (filter.status === 'loading') return t('map:userPlaces.loading');
    if (filter.status === 'error') return t('map:userPlaces.failed', { message: filter.error || '' });
    if (!filter.places?.length) return filter.relation?.self ? t('map:userPlaces.emptySelf') : t('map:userPlaces.empty');
    return '';
}

/** 地图上的筛选条：“九日缤 的 12 个地点” */
export function userPlacesChipText(filter) {
    if (!filter) return '';
    if (filter.status !== 'ready') return t('map:userPlaces.chipLoading', { name: filter.user.name });
    return filter.relation?.self
        ? t('map:userPlaces.chipSelf', { count: filter.total })
        : t('map:userPlaces.chip', { name: filter.user.name, count: filter.total });
}

/** 列表一行的次要信息：（审核中 · ）分类 · 人均 · 创建日期 */
export function userPlaceDetail(place) {
    const created = formatPlaceDay(place.created_time);
    return [
        isHiddenPlace(place) ? t('map:userPlaces.reviewing') : null,
        place.category || t('common:label.uncategorized'),
        place.per_person_cost != null ? t('map:ui.perPersonCost', { per_person_cost: place.per_person_cost }) : null,
        created ? t('map:userPlaces.created', { date: created }) : null
    ].filter(Boolean).join(' · ');
}

/** 自己创建、还在审核中（或未通过）的地点：只有自己看得到 */
export const isHiddenPlace = (place) => !!place.moderation_status && place.moderation_status !== 'visible';

const ROW_PREFIX = 'place-';
export const userPlaceRowId = (place) => `${ROW_PREFIX}${place.id}`;
export function userPlaceFromRowId(filter, rowId) {
    if (!filter?.places || typeof rowId !== 'string' || !rowId.startsWith(ROW_PREFIX)) return null;
    const id = rowId.slice(ROW_PREFIX.length);
    return filter.places.find((place) => String(place.id) === id) || null;
}

/**
 * 列表底部的操作（网页按钮与原生面板行共用 id）。目前只有退出筛选；
 * 以后的“屏蔽 / 取消屏蔽”按 filter.relation（不是自己时）加在这里，网页与 iOS 原生同时出现。
 */
export function userPlacesActions(filter) {
    if (!filter) return [];
    return [
        { id: 'exit', title: t('map:userPlaces.exit'), symbol: 'xmark.circle', icon: 'filter_alt_off' }
    ];
}

/** iOS 原生列表面板（list：工具栏上方的玻璃面板，点地图或下滑关闭，筛选仍保留） */
export function userPlacesChromeSheet(filter) {
    const message = userPlacesMessage(filter);
    return {
        id: 'userPlaces',
        title: userPlacesTitle(filter),
        subtitle: userPlacesSummary(filter) || undefined,
        size: 'list',
        message: message || undefined,
        messageTone: filter.status === 'loading' ? 'loading' : (filter.status === 'error' ? 'danger' : undefined),
        // 操作在前：列表最多 200 行，退出筛选（以后的屏蔽）不沉到最底下
        sections: [
            {
                id: 'actions',
                rows: [
                    filter.status === 'error' && { id: 'retry', title: t('map:userPlaces.retry'), symbol: 'arrow.clockwise' },
                    ...userPlacesActions(filter).map(({ icon, ...row }) => row)
                ].filter(Boolean)
            },
            filter.status === 'ready' && filter.places.length > 0 && {
                id: 'places',
                rows: filter.places.map((place) => ({
                    id: userPlaceRowId(place),
                    title: place.name || t('common:label.unnamedPlace'),
                    subtitle: userPlaceDetail(place),
                    symbol: 'mappin.circle.fill',
                    tone: isAvoidedPlace(place) ? 'danger' : (isHiddenPlace(place) ? 'warning' : undefined)
                }))
            }
        ].filter(Boolean)
    };
}
