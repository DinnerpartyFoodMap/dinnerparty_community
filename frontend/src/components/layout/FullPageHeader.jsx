import React from 'react';
import { t } from "../../i18n/index.js";

// 整页标题栏（路由子页、iOS 全屏面板、顺路吃、日记 · 同好共用），与 iOS 原生导航栏一致：
// 左边 44 圆形返回钮，标题居中（可带一行小字），右边文字操作；两侧等宽，标题始终居中。安全区由外层 AppFrame / OverlayHost 处理。
export default function FullPageHeader({ title, subtitle, onBack, backLabel = t('common:action.back'), right }) {
    return <header className="fm-full-page__header">
        <div className="fm-full-page__side">
            {onBack && <button type="button" className="fm-full-page__back fm-pressable" onClick={onBack} aria-label={backLabel}>
                <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
            </button>}
        </div>
        <div className="fm-full-page__heading"><h2>{title}</h2>{subtitle && <small>{subtitle}</small>}</div>
        <div className="fm-full-page__side fm-full-page__actions">{right}</div>
    </header>;
}
