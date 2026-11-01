// 原生日记 · 同好宿主：不渲染网页界面，只驱动原生页面与执行它交回的请求。
import { useEffect } from 'react';
import { createNativeJourneySession } from '../platform/nativeJourney.js';
import { getPlatform, isPluginAvailable } from '../platform/env.js';
import { createNativeJourneyController } from './nativeJourneyController.js';
import { nativeThemeColors } from '../theme/theme.js';

/** 当前安装包能否用原生日记 · 同好（iOS App 且包含插件） */
export function supportsNativeJourney() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeJourney');
}

export default function useNativeJourney({
    open,
    backendUrl,
    token,
    user,
    dark,
    onClose,
    onOpenPlace,
    onOpenFeedback,
    onShowMap,
    onOpenShare,
    onRequireAuth,
    onUnavailable
}) {
    useEffect(() => {
        if (!open || !token || !user) return undefined;
        let cancelled = false;
        let session = null;
        const controller = createNativeJourneyController({
            backendUrl,
            token,
            user,
            onClose,
            onOpenPlace,
            onOpenFeedback,
            onShowMap,
            onOpenShare,
            onRequireAuth,
            onUpdate: (page) => { session?.update(page); }
        });
        (async () => {
            try {
                // 不等网络：先打开没有未完成计数的入口，计数读到后再推送（用户已经进了下一级就不推）
                const page = controller.initialPage();
                const entryPromise = controller.refreshEntry().catch(() => null);
                const { registerPlugin } = await import('@capacitor/core');
                if (cancelled) return;
                session = createNativeJourneySession(registerPlugin('NativeJourney'), {
                    theme: { dark: !!dark, ...nativeThemeColors() }
                }, {
                    onEvent: (type, event) => controller.handle(type, event),
                    onLoadImage: (imageId) => controller.loadImage(imageId),
                    onClose: () => { if (!cancelled) onClose?.(); },
                    onError: () => { if (!cancelled) onUnavailable?.(); }
                });
                const started = session.start(page);
                // open 已经发出之后再推送，原生按顺序先打开再更新
                entryPromise.then((entry) => { if (entry && !cancelled) session.update(entry); });
                await started;
            } catch (error) {
                if (!cancelled) onUnavailable?.(error);
            }
        })();
        return () => {
            cancelled = true;
            session?.stop();
        };
    }, [open, backendUrl, token, user?.id]);
}
