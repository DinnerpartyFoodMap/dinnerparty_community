import React from 'react';
import { t } from "../../i18n/index.js";

// 全屏子页面共用顺路吃的紧凑标题栏；安全区由外层 AppFrame / OverlayHost 处理。
export default function FullPageHeader({ title, subtitle, onBack, backLabel = t('common:action.back'), right }) {
    return <header className="fm-full-page__header">
        {onBack && <button type="button" className="fm-full-page__back" onClick={onBack} aria-label={backLabel}>
            <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
        </button>}
        <div className="fm-full-page__heading"><h2>{title}</h2>{subtitle && <small>{subtitle}</small>}</div>
        {right && <div className="fm-full-page__actions">{right}</div>}
    </header>;
}
