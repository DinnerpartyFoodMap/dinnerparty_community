// 反馈类型：value 与后端 modules/feedback/services/feedbackService.js 的 FEEDBACK_TYPES 一致；
// symbol 是 iOS 原生反馈页下拉菜单里用的 SF Symbol。
import { t } from '../i18n/index.js';
import { buildPublicUrl } from '../platform/runtimeConfig.js';

export const FEEDBACK_LIMITS = Object.freeze({ contentLength: 2000, images: 4 });

export const FEEDBACK_TYPES = Object.freeze([
    { value: 'bug', label: t('feedback:types.bug.label'), symbol: 'ladybug' },
    { value: 'suggestion', label: t('feedback:types.suggestion.label'), symbol: 'lightbulb' },
    { value: 'report', label: t('feedback:types.report.label'), symbol: 'exclamationmark.shield' },
    { value: 'account', label: t('feedback:types.account.label'), symbol: 'person.crop.circle.badge.questionmark' },
    { value: 'other', label: t('feedback:types.other.label'), symbol: 'ellipsis.bubble' }
]);

export const FEEDBACK_TYPE_VALUES = Object.freeze(FEEDBACK_TYPES.map((item) => item.value));

export function feedbackTypeLabel(value) {
    const item = FEEDBACK_TYPES.find((entry) => entry.value === value);
    return item ? item.label : value;
}

/** 举报地点：预填反馈表的类型与开头一段（地点名、编号、分享链接），住民接着写原因 */
export function placeReportPrefill(place) {
    return {
        type: 'report',
        content: t('feedback:placeReport.template', { name: place.name || t('common:label.unnamedPlace'), id: place.id, link: buildPublicUrl(`/p/${place.id}`) })
    };
}

/** 举报住民（同好名片）：预填住民名与编号 */
export function userReportPrefill(user) {
    return {
        type: 'report',
        content: t('feedback:userReport.template', { username: user.username || '', id: user.id })
    };
}

/** 举报公开日记：预填标题、作者与公开链接 */
export function diaryReportPrefill(journey) {
    return {
        type: 'report',
        content: t('feedback:diaryReport.template', {
            title: journey.title || t('feedback:diaryReport.untitled'),
            author: journey.author?.username || '',
            link: buildPublicUrl(`/?diary=${encodeURIComponent(journey.public_id)}`)
        })
    };
}

/** 只保留合法的预填：类型在白名单里，内容截到上限；不合法时返回 null（按普通反馈打开） */
export function normalizeFeedbackPrefill(prefill) {
    if (!prefill || typeof prefill !== 'object' || !FEEDBACK_TYPE_VALUES.includes(prefill.type)) return null;
    const content = typeof prefill.content === 'string' ? prefill.content.slice(0, FEEDBACK_LIMITS.contentLength) : '';
    return { type: prefill.type, content };
}
