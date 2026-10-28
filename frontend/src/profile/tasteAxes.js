// 住民主页的六类餐饮偏好（后端 modules/preferences/services/tasteAxes.js，说明见 ../doc/TASTE_AXES.md）。
// 轴的顺序与后端 TASTE_AXES 一致；改轴时两边与文案 profile:taste.axes.* 一起改。
import { t } from '../i18n/index.js';

export const TASTE_AXES = Object.freeze(['homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign']);
export const SELF_LEVELS = Object.freeze([4, 3, 2, 1]);

// 文案键写成字面量，i18n 检查才能覆盖
const AXIS_LABELS = {
    homestyle: () => t('profile:taste.axes.homestyle'),
    noodles: () => t('profile:taste.axes.noodles'),
    hotpotBbq: () => t('profile:taste.axes.hotpotBbq'),
    dessert: () => t('profile:taste.axes.dessert'),
    drinks: () => t('profile:taste.axes.drinks'),
    foreign: () => t('profile:taste.axes.foreign')
};
const SELF_LEVEL_LABELS = {
    4: () => t('profile:taste.self.level4'),
    3: () => t('profile:taste.self.level3'),
    2: () => t('profile:taste.self.level2'),
    1: () => t('profile:taste.self.level1')
};

export function axisLabel(key) {
    return AXIS_LABELS[key] ? AXIS_LABELS[key]() : key;
}

export function selfLevelLabel(level) {
    return SELF_LEVEL_LABELS[level] ? SELF_LEVEL_LABELS[level]() : '';
}

/** 显示值（0–1）→ 一个词；null 是“待了解” */
export function valueWord(value) {
    if (value === null || value === undefined) return t('profile:taste.unknown');
    if (value >= 0.8) return t('profile:taste.word.love');
    if (value >= 0.6) return t('profile:taste.word.like');
    if (value >= 0.4) return t('profile:taste.word.neutral');
    return t('profile:taste.word.dislike');
}

/** 按后端返回的顺序整理；缺的轴补成“待了解”，多出来的轴丢掉 */
export function normalizeTaste(list) {
    const byKey = new Map((Array.isArray(list) ? list : []).filter((axis) => axis && TASTE_AXES.includes(axis.key)).map((axis) => [axis.key, axis]));
    return TASTE_AXES.map((key) => {
        const axis = byKey.get(key) || {};
        const value = typeof axis.value === 'number' && Number.isFinite(axis.value) ? Math.max(0, Math.min(1, axis.value)) : null;
        return {
            key,
            value,
            basis: ['self', 'evidence', 'embedding'].includes(axis.basis) ? axis.basis : null,
            selfLevel: SELF_LEVELS.includes(axis.self_level) ? axis.self_level : null,
            storeCount: Number(axis.store_count) || 0,
            positiveCount: Number(axis.positive_count) || 0,
            negativeCount: Number(axis.negative_count) || 0,
            favoriteCount: Number(axis.favorite_count) || 0,
            embedding: axis.embedding && typeof axis.embedding === 'object' ? axis.embedding : null,
            places: Array.isArray(axis.places) ? axis.places.filter((place) => place && place.id != null) : []
        };
    });
}

/** 一轴的依据说明：“依据 4 家店，其中 2 次明确好评”等 */
export function axisEvidenceText(axis) {
    if (axis.basis === 'self') return t('profile:taste.basis.self', { level: selfLevelLabel(axis.selfLevel) });
    if (axis.basis === 'evidence') {
        const parts = [t('profile:taste.basis.stores', { count: axis.storeCount })];
        if (axis.positiveCount) parts.push(t('profile:taste.basis.positive', { count: axis.positiveCount }));
        if (axis.negativeCount) parts.push(t('profile:taste.basis.negative', { count: axis.negativeCount }));
        if (axis.favoriteCount) parts.push(t('profile:taste.basis.favorites', { count: axis.favoriteCount }));
        return parts.join(t('profile:taste.basis.separator'));
    }
    if (axis.basis === 'embedding' && axis.embedding) {
        return t('profile:taste.basis.embedding', { count: axis.embedding.shop_count, percent: Math.round(axis.embedding.percentile * 100) });
    }
    return t('profile:taste.basis.unknown');
}
