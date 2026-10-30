// 住民主页的原生视图模型：把后端 profile 整理成 SwiftUI 可直接显示的文案与数值。
// 六轴雷达、小组件与屏蔽状态都沿用网页规则，文案仍走 i18n；原生不访问后端。
import { axisLabel, normalizeTaste, selfLevelLabel, valueWord } from './tasteAxes.js';
import { formatAverage, ratingTierFor, tierForAverage, tierLabel } from '../places/rating.js';
import { imageThumbnailUrl } from '../platform/runtimeConfig.js';
import { t } from '../i18n/index.js';

export const PROFILE_WIDGET_KINDS = Object.freeze(['collection', 'recent', 'favorite']);

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
    return PROFILE_WIDGET_KINDS.map((id) => ({ id, title: WIDGET_TITLE[id]() }));
}

export function profileSelfLevels() {
    return [4, 3, 2, 1].map((id) => ({ id, label: selfLevelLabel(id) }));
}

function widgetTitle(kind) {
    return WIDGET_TITLE[kind]?.() || '';
}

function widgetEmpty(kind) {
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

function buildSection(kind, data) {
    if (kind === 'collection') {
        const collections = Array.isArray(data) ? data : [];
        return {
            kind,
            title: widgetTitle(kind),
            empty: collections.length ? '' : widgetEmpty(kind),
            groups: collections.map((collection) => ({
                id: String(collection.id),
                title: t('profile:widgets.collection.item', { title: collection.title, count: collection.total }),
                rows: (Array.isArray(collection.places) ? collection.places : []).map((place) => placeRow(place, false))
            }))
        };
    }
    const places = Array.isArray(data) ? data : [];
    return {
        kind,
        title: widgetTitle(kind),
        empty: places.length ? '' : widgetEmpty(kind),
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
export function buildProfileViewModel(profile, { currentUser, tokenPresent, avatarURL, labels } = {}) {
    const user = profile?.user || {};
    const relation = profile?.relation || {};
    const self = !!relation.self || (currentUser && String(currentUser.id) === String(user.id));
    const widgets = (Array.isArray(profile?.widgets) ? profile.widgets : [])
        .filter((kind) => PROFILE_WIDGET_KINDS.includes(kind));
    const content = profile?.content || {};
    const axes = normalizeTaste(profile?.taste).map((axis) => ({
        key: axis.key,
        label: axisLabel(axis.key),
        value: axis.value,
        estimated: axis.basis === 'embedding',
        selfLevel: axis.selfLevel,
        accessible: t('profile:taste.axisAria', { axis: axisLabel(axis.key), value: valueWord(axis.value) })
    }));
    const name = user.username || t('profile:anonymous');
    return {
        name: String(name),
        avatarURL: user.has_avatar && avatarURL ? String(avatarURL) : '',
        city: profile?.city ? t('profile:city', { city: profile.city }) : t('profile:cityUnknown'),
        self,
        canEditTaste: self && !!tokenPresent,
        canEditWidgets: self && !!tokenPresent,
        canBlock: !!relation.can_block,
        blocked: !!relation.blocked,
        widgets,
        widgetSlotLabels: [1, 2, 3].map((index) => t('profile:widgets.slot', { index })),
        sections: widgets.map((kind) => buildSection(kind, content[kind])),
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
        loadFailed: t('profile:loadFailed'),
        notFound: t('profile:notFound')
    };
}
