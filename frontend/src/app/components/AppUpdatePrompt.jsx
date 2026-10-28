import React, { useEffect, useState } from 'react';
import ResponsivePanel from '../../components/overlay/ResponsivePanel';
import Button from '../../components/primitives/Button';
import { fetchAppRelease } from '../../api/client';
import { getPlatform, isNativePlatform } from '../../platform/env';
import { buildPublicUrl } from '../../platform/runtimeConfig';
import { openExternal } from '../../platform/navigation';
import { needsUpdate } from '../../platform/appUpdate';
import { t } from '../../i18n/index.js';

async function readLocalBuild() {
    try {
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        return info && info.build;
    } catch {
        return null;
    }
}

// App（Android / iOS）每次冷启动检查一次更新：本机构建号（Android versionCode / iOS CFBundleVersion）与服务器
// GET /api/app/release 里这一端的 build 比较（backend/modules/appRelease），有新版时弹窗显示版本号与更新说明，
// “去更新”用系统浏览器打开公开网站的 /home 下载页。网页端不检查。
export default function AppUpdatePrompt({ backendUrl }) {
    const [release, setRelease] = useState(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const platform = getPlatform();
        if (!isNativePlatform() || !['android', 'ios'].includes(platform)) return undefined;
        const controller = new AbortController();
        (async () => {
            try {
                const [data, build] = await Promise.all([fetchAppRelease(backendUrl, { signal: controller.signal }), readLocalBuild()]);
                const entry = data && data[platform];
                if (!controller.signal.aborted && needsUpdate(build, entry)) {
                    setRelease(entry);
                    setOpen(true);
                }
            } catch { /* 离线或服务器没配置时不提示 */ }
        })();
        return () => controller.abort();
    }, [backendUrl]);

    const update = () => {
        setOpen(false);
        openExternal(buildPublicUrl('/home/'));
    };

    return (
        <ResponsivePanel
            open={open && !!release}
            onClose={() => setOpen(false)}
            title={t('platform:appUpdate.title')}
            kind="app-update"
            desktop="center"
            mobile="center"
            width="min(420px, calc(100vw - 32px))"
            bodyStyle={{ padding: 16 }}
        >
            {release && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--color-text-primary)' }}>
                    <div style={{ fontWeight: 700 }}>
                        {release.version ? t('platform:appUpdate.version', { version: release.version }) : t('platform:appUpdate.versionUnknown')}
                    </div>
                    {release.notes && (
                        <div style={{ maxHeight: '40vh', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
                            {release.notes}
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                        <Button themeAware onClick={() => setOpen(false)}>{t('platform:appUpdate.later')}</Button>
                        <Button themeAware onClick={update}>{t('platform:appUpdate.update')}</Button>
                    </div>
                </div>
            )}
        </ResponsivePanel>
    );
}
