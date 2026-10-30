// 原生管理后台的网页侧入口：创建控制器与会话，所有请求仍由网页携带凭证执行。
import { useEffect } from 'react';
import { createNativeAdminSession } from '../platform/nativeAdmin.js';
import { getPlatform, isPluginAvailable } from '../platform/env.js';
import { t } from '../i18n/index.js';
import { createNativeAdminController } from './nativeAdminController.js';

/** 当前安装包能否用原生管理后台（iOS App 且包含插件） */
export function supportsNativeAdmin() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeAdmin');
}

export default function useNativeAdmin({ backendUrl, token, user, dark, onBack, onOpenPlace, onRequireAuth, onUnavailable }) {
    useEffect(() => {
        if (!token || !user?.admin_level) return undefined;
        let cancelled = false;
        let session = null;
        const controller = createNativeAdminController({ backendUrl, token, user, onRequireAuth, onOpenPlace });
        (async () => {
            try {
                const { registerPlugin } = await import('@capacitor/core');
                if (cancelled) return;
                session = createNativeAdminSession(registerPlugin('NativeAdmin'), {
                    dashboard: controller.dashboard(),
                    theme: { dark: !!dark },
                    labels: { close: t('common:action.close') }
                }, {
                    onEvent: (type, event) => controller.handle(type, event),
                    onLoadImage: (imageId) => controller.loadImage(imageId),
                    onClose: () => { if (!cancelled) onBack?.(); },
                    onError: () => { if (!cancelled) onUnavailable?.(); }
                });
                await session.start();
            } catch (error) {
                if (!cancelled) onUnavailable?.(error);
            }
        })();
        return () => {
            cancelled = true;
            session?.stop();
        };
    }, [backendUrl, token, user?.id, user?.admin_level]);
}
