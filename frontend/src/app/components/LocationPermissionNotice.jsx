import React, { useEffect, useState } from 'react';
import MotionSurface from '../../components/overlay/MotionSurface';
import { onLocationPermissionPrompt } from '../../platform/geolocation';
import { materialIcon } from '../../platform/iconRegistry';
import { t } from '../../i18n/index.js';

// Android 弹出系统定位授权时在屏幕顶部说明用途（应用市场的隐私合规检测要求申请权限的同时告知目的）。
// 由 platform/geolocation.js 在 requestPermissions 前后通知，所有发起定位的地方（地图定位按钮、日记选当前地点）共用；
// 系统弹窗盖住下半屏且网页层变暗，说明条放在状态栏下方，不接收点击。
export default function LocationPermissionNotice() {
    const [active, setActive] = useState(false);

    useEffect(() => onLocationPermissionPrompt(setActive), []);

    return (
        <MotionSurface
            show={active}
            preset="dropdown"
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                top: 'calc(var(--safe-top, 0px) + var(--space-3))',
                left: 'calc(var(--safe-left, 0px) + var(--space-3))',
                right: 'calc(var(--safe-right, 0px) + var(--space-3))',
                zIndex: 'var(--z-toast)',
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'flex-start',
                padding: 'var(--space-3) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                boxShadow: 'var(--shadow-md)',
                color: 'var(--color-text-primary)',
                pointerEvents: 'none'
            }}
        >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 24, color: 'var(--theme-primary-text)' }}>
                {materialIcon('place')}
            </span>
            <div style={{ minWidth: 0 }}>
                <div style={{ font: 'var(--text-headline)' }}>{t('platform:geolocation.permissionNoticeTitle')}</div>
                <div style={{ font: 'var(--text-footnote)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>
                    {t('platform:geolocation.permissionNoticeBody')}
                </div>
            </div>
        </MotionSurface>
    );
}
