import { useEffect, useRef, useState } from 'react';
import { useOverlayEntry } from '../../components/overlay/MotionSurface';
import { getPlatform, isPluginAvailable } from '../../platform/env';
import { createNativePlaceFormSession } from '../../platform/nativePlaceForm';
import { loadCategoryDirectory } from '../categoryDirectory';
import { RATING_TIERS } from '../rating';
import { PLACE_IMAGE_PICK_LIMIT, uploadPlaceImage } from '../components/PlaceImageInputs';
import { imageThumbnailUrl } from '../../platform/runtimeConfig';
import { getThemeColor } from '../../theme/theme';
import useDarkMode from '../../theme/useDarkMode';
import { t } from '../../i18n/index.js';

/** 当前安装包能否用原生地点表单（iOS App 且包含插件） */
export function supportsNativePlaceForm() {
    return getPlatform() === 'ios' && isPluginAvailable('NativePlaceForm');
}

function base64ToFile(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], `place-${Date.now()}.jpg`, { type: 'image/jpeg' });
}

// 评价四档的颜色：tone 是 CSS 变量，取当前主题（浅色 / 深色）下的实际值，原生表单用它给选项上色
function tierColor(tone) {
    const name = /^var\((--[\w-]+)\)$/.exec(tone)?.[1];
    if (!name) return tone;
    try {
        return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
    } catch {
        return undefined;
    }
}

const imageEntries = (list) => (Array.isArray(list) ? list : [])
    .filter((url) => typeof url === 'string' && url)
    .map((url) => ({ url, thumb: imageThumbnailUrl(url, 240) }));

// 原生表单的文案都由网页下发（走 i18n），原生只保留中文兜底
function formLabels(mode, canDirect) {
    return {
        title: mode === 'create' ? t('map:placeForm.titleCreate') : t('map:placeForm.titleEdit'),
        expand: t('map:placeForm.expand'),
        name: t('map:placeForm.name'),
        namePlaceholder: t('map:addForm.namePlaceholder'),
        nameRequired: t('map:addForm.nameRequired'),
        category: t('map:placeForm.category'),
        categoryNone: t('map:placeForm.categoryNone'),
        categorySearch: t('map:placeForm.categorySearch'),
        categoryAdd: t('map:placeForm.categoryAdd'),
        categoryInvalid: t('map:placeForm.categoryInvalid'),
        clearSearch: t('map:ui.search.clear'),
        description: t('map:common.label.description'),
        descriptionPlaceholder: t('map:placeForm.descriptionPlaceholder'),
        markdownHint: t('map:placeForm.markdownHint'),
        cost: t('map:placeForm.cost'),
        costPlaceholder: t('map:addForm.perPersonCostPlaceholder'),
        rating: t('map:addForm.ratingLabel'),
        ratingRequired: t('map:addForm.ratingRequired'),
        exteriorImages: t('map:addForm.exteriorImages'),
        menuImages: t('map:addForm.menuImages'),
        chooseFromAlbum: t('map:placeForm.chooseFromAlbum'),
        takePhoto: t('common:action.takePhoto'),
        removeImage: t('map:placeForm.removeImage'),
        uploading: t('map:imageInputs.uploading'),
        retryUpload: t('map:imageInputs.retryUpload'),
        imageUnreadable: t('map:placeForm.imageUnreadable'),
        address: t('map:placeForm.address'),
        position: t('map:placeForm.position'),
        pickPosition: t('map:manage.modifyPosition'),
        needsReview: t('map:manage.needsReview'),
        delete: t('map:placeForm.delete'),
        deleteTitle: t('map:main.confirmDelete'),
        cancel: t('common:action.cancel'),
        submit: mode === 'create' ? t('map:addForm.submit') : (canDirect ? t('common:action.save') : t('map:manage.submitRequest')),
        submitting: t('map:placeForm.submitting'),
        discardTitle: t('map:placeForm.discardTitle'),
        discard: t('map:placeForm.discard'),
        keepEditing: t('map:placeForm.keepEditing'),
        ok: t('map:placeForm.ok'),
        timeout: t('map:placeForm.timeout'),
        failed: t('map:placeForm.failed')
    };
}

/**
 * open 期间在 iOS 上呈现原生地点表单（NativePlaceFormPlugin.swift）。form 描述这次打开：
 *   { mode: 'create' | 'edit', key, values, address, position, canDirect, canDelete, canPickPosition }
 * key 变化时重新打开（例如选完位置回来）。onSubmit / onDelete 返回 { ok, message }；onFinish(action, values)。
 * 打不开或异常结束时返回 false，调用方改用网页表单；关闭后下次重新尝试原生。
 */
export default function useNativePlaceForm({ open, form, backendUrl, token, onSubmit, onDelete, onFinish }) {
    const supported = supportsNativePlaceForm();
    const dark = useDarkMode();
    const [failed, setFailed] = useState(false);
    const latest = useRef({ form, token, dark, onSubmit, onDelete, onFinish });
    latest.current = { form, token, dark, onSubmit, onDelete, onFinish };
    const active = supported && !failed && open && !!form;
    // 打开期间收起地图原生控件（地点卡片也是系统面板，不让位表单就弹不出来）
    useOverlayEntry(active ? { kind: 'native-place-form', label: form.mode === 'create' ? t('map:placeForm.titleCreate') : t('map:placeForm.titleEdit'), modal: false, closeOnEscape: false, consumeBack: false } : null);

    useEffect(() => {
        if (!open) setFailed(false);
    }, [open]);

    const formKey = active ? `${form.mode}:${form.key}` : null;
    useEffect(() => {
        if (!formKey) return undefined;
        let cancelled = false, session;
        (async () => {
            const [{ registerPlugin }, categories] = await Promise.all([
                import('@capacitor/core'),
                loadCategoryDirectory(backendUrl).catch(() => [])
            ]);
            if (cancelled) return;
            const current = latest.current.form;
            const values = current.values || {};
            const snapshot = {
                mode: current.mode,
                dark: latest.current.dark,
                primary: getThemeColor() || '#E2789F',
                categories: categories.map((item) => ({ name: item.name, common: !!item.is_common })),
                tiers: RATING_TIERS.map((tier) => ({ score: tier.score, title: tier.label, hint: tier.hint, color: tierColor(tier.tone) })),
                limits: { descriptionLength: 1000, images: PLACE_IMAGE_PICK_LIMIT },
                canDirect: current.canDirect !== false,
                canDelete: !!current.canDelete,
                canPickPosition: !!current.canPickPosition,
                address: current.address || '',
                position: current.position || '',
                values: {
                    name: values.name || '',
                    category: values.category || '',
                    description: values.description || '',
                    perPersonCost: values.perPersonCost != null ? String(values.perPersonCost) : '',
                    rating: values.rating ?? null,
                    exteriorImages: imageEntries(values.exteriorImages),
                    menuImages: imageEntries(values.menuImages)
                },
                labels: formLabels(current.mode, current.canDirect !== false)
            };
            session = createNativePlaceFormSession(registerPlugin('NativePlaceForm'), snapshot, {
                onUpload: async (image) => {
                    try {
                        return { ok: true, url: await uploadPlaceImage(backendUrl, latest.current.token, base64ToFile(image)) };
                    } catch (error) {
                        return { ok: false, message: error.message || t('map:imageInputs.uploadFailed') };
                    }
                },
                onSubmit: (submitted) => latest.current.onSubmit(submitted),
                onDelete: () => (latest.current.onDelete ? latest.current.onDelete() : { ok: false, message: '' }),
                onFinish: (action, finalValues) => { if (!cancelled) latest.current.onFinish?.(action, finalValues); },
                onError: () => { if (!cancelled) setFailed(true); }
            });
            await session.start();
        })().catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; session?.stop(); };
    }, [formKey, backendUrl]);

    return supported && !failed;
}
