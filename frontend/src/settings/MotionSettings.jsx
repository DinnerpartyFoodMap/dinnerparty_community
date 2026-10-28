import React, { useSyncExternalStore } from 'react';
import { setMotionPreferences } from '../motion/policy';
import { useMotionPolicy } from '../motion/MotionProvider';
import { getPlatform } from '../platform/env';
import { canUseNativeMapChrome, getNativeChromeStatus, subscribeNativeChromeStatus } from '../platform/nativeMapChrome';
import { t, tx } from '../i18n/index.js';

// 动效开关：本机偏好，立即生效（不随账号同步）。关闭动效只影响过渡表现，地图同步与数据正确性不受影响。
export const MOTION_ITEMS = [
    { key: 'clusterMotion', label: t('settings:motion.cluster.label'), hint: t('settings:motion.cluster.hint') },
    { key: 'webMotion', label: t('settings:motion.web.label'), hint: t('settings:motion.web.hint') },
    { key: 'nativeGlass', label: t('settings:motion.nativeGlass.label'), hint: t('settings:motion.nativeGlass.hint'), iosOnly: true },
    { key: 'clusterGlass', label: t('settings:motion.clusterGlass.label'), hint: t('settings:motion.clusterGlass.hint'), iosOnly: true }
];

// 原生控件最近一次握手的结果，便于真机上直接看到没有启用的原因（iOS 原生设置页也用它）
export function describeNativeChrome(status) {
    if (!canUseNativeMapChrome()) return t('settings:motion.native.notIncluded');
    switch (status.state) {
        case 'native': return t('settings:motion.native.enabled');
        case 'connecting': return t('settings:motion.native.connecting');
        case 'unsupported': return t('settings:motion.native.unavailable', { reason: status.reason });
        case 'web': return t('settings:motion.native.fallback', { reason: status.reason, retrying: status.retrying ? t('settings:motion.native.retrying') : '' });
        default: return t('settings:motion.native.notConnected');
    }
}

export default function MotionSettings() {
    const policy = useMotionPolicy();
    const platform = getPlatform();
    const chromeStatus = useSyncExternalStore(subscribeNativeChromeStatus, getNativeChromeStatus);
    return (
        <section aria-labelledby="motion-settings-title" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
            <h3 id="motion-settings-title" style={{ margin: '0 0 4px', fontSize: 15 }}>{t('settings:motion.title')}</h3>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {tx('settings:motion.localOnly', { reducedMotion: policy.reducedMotion ? t('settings:motion.reducedMotion') : '' })}
            </p>
            {MOTION_ITEMS.filter((item) => !item.iosOnly || platform === 'ios').map((item) => (
                <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', cursor: 'pointer' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14 }}>{item.label}</span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>{item.hint}</span>
                        {item.key === 'nativeGlass' && policy.preferences.nativeGlass && (
                            <span role="status" style={{ display: 'block', fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, overflowWrap: 'anywhere' }}>
                                {describeNativeChrome(chromeStatus)}
                            </span>
                        )}
                    </span>
                    <input
                        type="checkbox"
                        role="switch"
                        checked={!!policy.preferences[item.key]}
                        aria-checked={!!policy.preferences[item.key]}
                        onChange={(event) => setMotionPreferences({ [item.key]: event.target.checked })}
                        style={{ width: 22, height: 22, accentColor: 'var(--theme-primary)', flexShrink: 0 }}
                    />
                </label>
            ))}
        </section>
    );
}
