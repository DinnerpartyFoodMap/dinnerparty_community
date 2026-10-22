import { useEffect, useRef, useState } from 'react';
import { useOverlayEntry } from '../components/overlay/MotionSurface';
import { getPlatform, isPluginAvailable } from '../platform/env';
import { createNativeFeedbackSession } from '../platform/nativeFeedback';
import { getThemeColor } from '../theme/theme';
import useDarkMode from '../theme/useDarkMode';
import { FEEDBACK_LIMITS, FEEDBACK_TYPES, FEEDBACK_TYPE_VALUES } from './feedbackTypes';
import { submitFeedback } from './feedbackApi';
import { t } from '../i18n/index.js';

/** 当前安装包能否用原生反馈页（iOS App 且包含插件） */
export function supportsNativeFeedback() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeFeedback');
}

// 原生页的类型、上限与全部文案都由网页下发（文案走 i18n），原生只负责展示与输入；
// prefill 是预填的类型与内容开头（地点举报），原生以此为初始值，只有预填时不算草稿、也不能提交
function buildSnapshot(dark, prefill) {
    return {
        dark,
        primary: getThemeColor() || '#E2789F',
        types: FEEDBACK_TYPES.map(({ value, label, hint, symbol }) => ({ id: value, title: label, hint, symbol })),
        limits: { ...FEEDBACK_LIMITS },
        ...(prefill ? { prefill: { type: prefill.type, content: prefill.content } } : null),
        labels: {
            title: t('feedback:title'),
            intro: t('feedback:intro'),
            typeLabel: t('feedback:typeLabel'),
            typePlaceholder: t('feedback:typePlaceholder'),
            contentLabel: t('feedback:contentLabel'),
            contentPlaceholder: t('feedback:contentPlaceholder'),
            imagesLabel: t('feedback:imagesLabel'),
            imagesHint: t('feedback:imagesHint', { max: FEEDBACK_LIMITS.images }),
            submit: t('feedback:submit'),
            submitting: t('feedback:submitting'),
            cancel: t('feedback:native.cancel'),
            chooseFromAlbum: t('feedback:native.chooseFromAlbum'),
            takePhoto: t('feedback:native.takePhoto'),
            removeImage: t('feedback:native.removeImage'),
            imageUnreadable: t('feedback:native.imageUnreadable'),
            discardTitle: t('feedback:native.discardTitle'),
            discardMessage: t('feedback:native.discardMessage'),
            discard: t('feedback:native.discard'),
            keepEditing: t('feedback:native.keepEditing'),
            ok: t('feedback:native.ok'),
            timeout: t('feedback:native.timeout'),
            failed: t('feedback:native.failed')
        }
    };
}

function base64ToBlob(base64, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
}

// open 期间在 iOS 上呈现原生反馈页；原生页结束（提交成功或取消）时调用 onClose(action)。
// 打不开或异常结束时返回 false，调用方改用网页面板；下次打开重新尝试原生。
export default function useNativeFeedback({ open, backendUrl, token, onClose, prefill = null }) {
    const supported = supportsNativeFeedback();
    const dark = useDarkMode();
    const [failed, setFailed] = useState(false);
    const latest = useRef({ token, onClose, dark, prefill });
    latest.current = { token, onClose, dark, prefill };
    const active = supported && !failed && open;
    // 原生页打开期间收起地图原生控件：地点卡片也是系统面板，不让位反馈页就弹不出来（从卡片举报时），关闭后卡片回来
    useOverlayEntry(active ? { kind: 'native-feedback', label: t('feedback:title'), modal: false, closeOnEscape: false, consumeBack: false } : null);

    useEffect(() => {
        if (!open) setFailed(false);
    }, [open]);

    useEffect(() => {
        if (!supported || failed || !open) return undefined;
        let cancelled = false, session;
        (async () => {
            const { registerPlugin } = await import('@capacitor/core');
            if (cancelled) return;
            session = createNativeFeedbackSession(registerPlugin('NativeFeedback'), buildSnapshot(latest.current.dark, latest.current.prefill), {
                types: FEEDBACK_TYPE_VALUES,
                limits: FEEDBACK_LIMITS,
                onSubmit: (values) => submitFeedback({
                    backendUrl, token: latest.current.token, type: values.type, content: values.content,
                    images: values.images.map((image) => base64ToBlob(image, 'image/jpeg'))
                }),
                onFinish: (action) => { if (!cancelled) latest.current.onClose?.(action); },
                onError: () => { if (!cancelled) setFailed(true); }
            });
            await session.start();
        })().catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; session?.stop(); };
    }, [supported, failed, open, backendUrl, prefill]);

    return supported && !failed;
}
