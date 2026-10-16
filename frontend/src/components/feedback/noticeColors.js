import { t } from "../../i18n/index.js";
export const NOTICE_COLOR_OPTIONS = [
    { key: 'blue', label: t('admin:noticeColors.blue'), backgroundColor: '#EAF4FC' },
    { key: 'green', label: t('admin:noticeColors.green'), backgroundColor: '#E9F5EF' },
    { key: 'amber', label: t('admin:noticeColors.amber'), backgroundColor: '#FFF0E3' },
    { key: 'rose', label: t('admin:noticeColors.rose'), backgroundColor: '#FCE8EF' },
    { key: 'slate', label: t('admin:noticeColors.slate'), backgroundColor: '#F2EEF5' }
];

export function getNoticeColorOption(colorKey) {
    const normalized = String(colorKey || '').trim().toLowerCase();
    return NOTICE_COLOR_OPTIONS.find((option) => option.key === normalized) || NOTICE_COLOR_OPTIONS[0];
}
