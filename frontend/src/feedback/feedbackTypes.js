// 反馈类型：value 与后端 modules/feedback/services/feedbackService.js 的 FEEDBACK_TYPES 一致；
// symbol 是 iOS 原生反馈页下拉菜单里用的 SF Symbol。
import { t } from '../i18n/index.js';

export const FEEDBACK_LIMITS = Object.freeze({ contentLength: 2000, images: 4 });

export const FEEDBACK_TYPES = Object.freeze([
    { value: 'bug', label: t('feedback:types.bug.label'), hint: t('feedback:types.bug.hint'), symbol: 'ladybug' },
    { value: 'suggestion', label: t('feedback:types.suggestion.label'), hint: t('feedback:types.suggestion.hint'), symbol: 'lightbulb' },
    { value: 'report', label: t('feedback:types.report.label'), hint: t('feedback:types.report.hint'), symbol: 'exclamationmark.shield' },
    { value: 'account', label: t('feedback:types.account.label'), hint: t('feedback:types.account.hint'), symbol: 'person.crop.circle.badge.questionmark' },
    { value: 'other', label: t('feedback:types.other.label'), hint: t('feedback:types.other.hint'), symbol: 'ellipsis.bubble' }
]);

export const FEEDBACK_TYPE_VALUES = Object.freeze(FEEDBACK_TYPES.map((item) => item.value));

export function feedbackTypeLabel(value) {
    const item = FEEDBACK_TYPES.find((entry) => entry.value === value);
    return item ? item.label : value;
}
