// 原生管理后台的网页侧入口：创建控制器与会话，所有请求仍由网页携带凭证执行。
import { useEffect } from 'react';
import { createNativeAdminSession } from '../platform/nativeAdmin.js';
import { getPlatform, isPluginAvailable } from '../platform/env.js';
import { t } from '../i18n/index.js';
import { createNativeAdminController } from './nativeAdminController.js';
import { nativeThemeColors } from '../theme/theme.js';

/** 当前安装包能否用原生管理后台（iOS App 且包含插件） */
export function supportsNativeAdmin() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeAdmin');
}

/**
 * suspended：网页正在给场馆选点，原生后台保持关闭。
 * resume：{ seq, section, message, error }，选点结束后重新打开并直接进入 section 那一页（seq 变化才重新打开）；
 * 旧安装包的原生插件不认 page，会停在后台首页。
 */
export default function useNativeAdmin({ backendUrl, token, user, dark, onBack, onOpenPlace, onPickVenue, onRequireAuth, onUnavailable, suspended = false, resume = null }) {
    useEffect(() => {
        if (!token || !user?.admin_level || suspended) return undefined;
        let cancelled = false;
        let session = null;
        const controller = createNativeAdminController({ backendUrl, token, user, onRequireAuth, onOpenPlace, onPickVenue });
        (async () => {
            try {
                const { registerPlugin } = await import('@capacitor/core');
                if (cancelled) return;
                // 首页先建（它会清掉已登记的动作），再载入要直接进入的那一页
                const dashboard = controller.dashboard();
                let page = null;
                if (resume?.section) {
                    try {
                        page = await controller.load(resume.section, { message: resume.message || '', error: resume.error || '' });
                    } catch {
                        page = null; // 读不到就停在首页，管理员自己再点进去
                    }
                    if (cancelled) return;
                }
                session = createNativeAdminSession(registerPlugin('NativeAdmin'), {
                    dashboard,
                    ...(page ? { page } : {}),
                    theme: { dark: !!dark, ...nativeThemeColors() },
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
        // suspended 不进依赖：开始选点时原生后台已由「在地图上定位」自己关闭（带动画），这里不必再停一次；
        // 选点期间别的依赖变了也不会重开（上面直接返回），选完靠 resume.seq 重新打开
    }, [backendUrl, token, user?.id, user?.admin_level, resume?.seq]);
}
