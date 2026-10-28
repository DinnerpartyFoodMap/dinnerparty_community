import React from 'react';
import Button from '../primitives/Button';
import { t } from '../../i18n/index.js';

// 网页端整页（地点列表、住民主页）的标题行：标题 + 返回地图，样式同住民设置页。
// 手机网页没有顶栏，这是回地图的唯一入口；iOS 由 RoutePageShell 的原生页头代替（fm-legacy-page-heading 在那里隐藏）。
export default function PageHeading({ title, onBack, className = '', style }) {
    return (
        <div
            className={`fm-legacy-page-heading ${className}`.trim()}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '50px 0 14px', ...style }}
        >
            <h2 style={{ margin: 0, minWidth: 0 }}>{title}</h2>
            {onBack && (
                <Button
                    themeAware
                    onClick={onBack}
                    style={{ minHeight: 40, padding: '7px 11px', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                >
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 19 }}>arrow_back</span>
                    {t('common:action.backToMap')}
                </Button>
            )}
        </div>
    );
}
