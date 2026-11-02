import { t } from "../../i18n/index.js";

// 公告颜色：background 是网页用的底色（语义色与卡片底混合，深浅模式自动跟随）；
// backgroundColor 是对应的浅色十六进制值，只给需要具体色值的地方（iOS 原生后台的色块与预览）。后端只存 key。
const tint = (color) => `color-mix(in srgb, ${color} 12%, var(--color-bg-surface))`;

export const NOTICE_COLOR_OPTIONS = [
    { key: 'blue', label: t('admin:noticeColors.blue'), background: tint('var(--color-info)'), backgroundColor: '#EAF4FC' },
    { key: 'green', label: t('admin:noticeColors.green'), background: tint('var(--color-success)'), backgroundColor: '#E9F5EF' },
    { key: 'amber', label: t('admin:noticeColors.amber'), background: tint('var(--color-warning)'), backgroundColor: '#FFF0E3' },
    { key: 'rose', label: t('admin:noticeColors.rose'), background: tint('var(--color-primary)'), backgroundColor: '#FCE8EF' },
    { key: 'slate', label: t('admin:noticeColors.slate'), background: 'var(--color-bg-overlay)', backgroundColor: '#F2EEF5' }
];

export function getNoticeColorOption(colorKey) {
    const normalized = String(colorKey || '').trim().toLowerCase();
    return NOTICE_COLOR_OPTIONS.find((option) => option.key === normalized) || NOTICE_COLOR_OPTIONS[0];
}
