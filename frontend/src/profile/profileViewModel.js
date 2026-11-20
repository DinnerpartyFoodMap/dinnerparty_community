// 住民主页的原生视图模型：把后端 profile 整理成 SwiftUI 可直接显示的文案与数值。
// 六轴雷达、小组件与屏蔽状态都沿用网页规则，文案仍走 i18n；原生不访问后端。
import { axisLabel, normalizeTaste, selfLevelLabel, axisValueWord } from './tasteAxes.js';
import { formatAverage, ratingTierFor, tierForAverage, tierLabel } from '../places/rating.js';
import { imageThumbnailUrl } from '../platform/runtimeConfig.js';
import { resolveAvatarUrl } from '../auth/avatarUrl.js';
import { t } from '../i18n/index.js';

export const PROFILE_WIDGET_KINDS = Object.freeze(['recent', 'favorite']);
// “调整小组件”里能关闭的：“我创建的地点”（recent）始终显示，只有“最喜欢”可以隐藏（后端同样只保存 favorite）
export const HIDEABLE_PROFILE_WIDGETS = Object.freeze(['favorite']);

// 文案键写成字面量，i18n 检查才能覆盖
const WIDGET_TITLE = {
    collection: () => t('profile:widgets.collection.title'),
    recent: () => t('profile:widgets.recent.title'),
    favorite: () => t('profile:widgets.favorite.title')
};
const WIDGET_EMPTY = {
    collection: () => t('profile:widgets.collection.empty'),
    recent: () => t('profile:widgets.recent.empty'),
    favorite: () => t('profile:widgets.favorite.empty')
};

export function profileWidgetOptions() {
    return HIDEABLE_PROFILE_WIDGETS.map((id) => ({ id, title: profileWidgetTitle(id, true) }));
}

export function hiddenProfileWidgets(profile) {
    const hidden = profile?.hidden_widgets;
    return Array.isArray(hidden) ? HIDEABLE_PROFILE_WIDGETS.filter((kind) => hidden.includes(kind)) : [];
}

export function profileRejectedPlaceCount(profile, currentUser) {
    const count = Number(profile?.rejected_place_count ?? currentUser?.rejected_place_count);
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function profileSelfLevels() {
    return [4, 3, 2, 1].map((id) => ({ id, label: selfLevelLabel(id) }));
}

export function profileWidgetTitle(kind, self) {
    if (self && kind === 'recent') return t('map:ui.myPlaces');
    if (self && kind === 'collection') return t('profile:widgets.collection.mine');
    return WIDGET_TITLE[kind]?.() || '';
}

export function profileWidgetEmpty(kind) {
    return WIDGET_EMPTY[kind]?.() || '';
}

function placeRow(place, showOwnScore) {
    const tier = showOwnScore ? ratingTierFor(place.own_score) : tierForAverage(place.rating_average);
    const meta = tier
        ? (showOwnScore ? tierLabel(tier) : t('profile:placeRating', { tier: tierLabel(tier), average: formatAverage(place.rating_average) }))
        : (place.category || '');
    return {
        id: String(place.id),
        name: String(place.name || ''),
        image: place.image ? imageThumbnailUrl(place.image, 200) : '',
        meta: String(meta || '')
    };
}

function buildSection(kind, data, self) {
    if (kind === 'collection') {
        const collection = data?.[0];
        const places = Array.isArray(collection?.places) ? collection.places : [];
        return {
            kind,
            title: profileWidgetTitle(kind, self),
            empty: places.length ? '' : profileWidgetEmpty(kind),
            groups: places.length ? [{ id: 'favorites', title: '', rows: places.map((place) => placeRow(place, false)) }] : []
        };
    }
    const places = Array.isArray(data) ? data : [];
    return {
        kind,
        title: profileWidgetTitle(kind, self),
        empty: places.length ? '' : profileWidgetEmpty(kind),
        groups: places.length
            ? [{
                id: kind,
                title: '',
                rows: places.map((place) => placeRow(place, kind === 'favorite'))
            }]
            : []
    };
}

/** 一次完整的住民主页快照；profile 为 GET /users/:id/profile 的响应。 */
export function buildProfileViewModel(profile, { currentUser, tokenPresent, backendUrl, labels } = {}) {
    const user = profile?.user || {};
    const relation = profile?.relation || {};
    const self = !!relation.self || (!!currentUser && String(currentUser.id) === String(user.id));
    const canUseAccountActions = self && !!tokenPresent;
    const widget = profile?.widgets?.findLast((kind) => PROFILE_WIDGET_KINDS.includes(kind)) || 'recent';
    const hiddenWidgets = hiddenProfileWidgets(profile);
    const rejectedPlaceCount = self ? profileRejectedPlaceCount(profile, currentUser) : 0;
    const content = profile?.content || {};
    const hasCollection = !relation.blocked && !!content.collection?.length;
    const placeWidgets = relation.blocked ? [] : PROFILE_WIDGET_KINDS.filter((kind) => !hiddenWidgets.includes(kind));
    const axes = normalizeTaste(profile?.taste).map((axis) => ({
        key: axis.key,
        label: axisLabel(axis.key),
        value: axis.value,
        selfLevel: axis.selfLevel,
        description: axisValueWord(axis),
        accessible: t('profile:taste.axisAria', { axis: axisLabel(axis.key), value: axisValueWord(axis) })
    }));
    const name = user.username || t('profile:anonymous');
    return {
        name: String(name),
        avatarURL: resolveAvatarUrl(user, backendUrl, { serverFallback: true }),
        city: profile?.city ? t('profile:city', { city: profile.city }) : t('profile:cityUnknown'),
        self,
        canEditTaste: canUseAccountActions,
        canEditWidgets: canUseAccountActions,
        canOpenCommunity: canUseAccountActions,
        canUseAccountActions,
        canOpenFavorites: hasCollection,
        canOpenLocations: placeWidgets.includes('recent'),
        rejectedPlaceCount,
        collectionVisibility: canUseAccountActions && typeof profile?.collection_visibility === 'boolean' ? profile.collection_visibility : null,
        canBlock: !!relation.can_block,
        blocked: !!relation.blocked,
        widgets: [widget],
        hiddenWidgets,
        widgetSlotLabels: [t('profile:widgets.slot', { index: 2 })],
        sections: [
            ...(hasCollection ? [buildSection('collection', content.collection, self)] : []),
            ...placeWidgets.map((kind) => buildSection(kind, content[kind], self))
        ],
        axes,
        labels: {
            ...labels,
            blockConfirm: t('profile:blockConfirm', { name }),
            blockedNote: t('profile:blockedNote'),
            tasteTitle: t('profile:taste.title'),
            tasteHint: t('profile:taste.hint'),
            selfTitle: t('profile:taste.self.title'),
            auto: t('profile:taste.self.auto'),
            widgetsEdit: t('profile:widgets.edit'),
            community: t('journey:common.feature.community'),
            viewAllFavorites: t('profile:widgets.collection.viewAll'),
            viewAllLocations: t('profile:widgets.collection.viewAll'),
            settings: t('map:ui.accountSettings'),
            companion: t('companion:title'),
            logout: t('map:ui.logout'),
            rejectedPlaces: rejectedPlaceCount ? t('map:ui.myPlacesRejected', { count: rejectedPlaceCount }) : '',
            collectionPublic: t('profile:widgets.collection.public'),
            collectionVisibilityFailed: t('profile:widgets.collection.saveVisibilityFailed'),
            save: t('common:action.save'),
            cancel: t('common:action.cancel'),
            ok: t('common:action.ok'),
            blockFailed: t('profile:blockFailed', { message: '' }),
            tasteSaveFailed: t('profile:taste.saveFailed'),
            widgetsSaveFailed: t('profile:widgets.saveFailed')
        }
    };
}

export function profileBaseLabels() {
    return {
        title: t('profile:title'),
        close: t('common:action.close'),
        back: t('common:action.back'),
        blockAndReport: t('profile:blockAndReport'),
        unblock: t('profile:unblock'),
        retry: t('profile:retry'),
        loading: t('common:status.loading'),
        loadFailed: t('profile:loadFailed'),
        notFound: t('profile:notFound')
    };
}
