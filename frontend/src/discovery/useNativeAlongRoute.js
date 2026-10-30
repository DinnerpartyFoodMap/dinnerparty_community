// 原生“顺路吃”面板的网页侧入口。调用方负责判断平台与插件可用性（enabled），
// 本 hook 负责取分类、打开会话、把网页的路线/结果格式化成原生可直接显示的文案。
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCategories } from '../api/client.js';
import { createNativeAlongRouteSession } from '../platform/nativeAlongRoute.js';
import {
    alongRouteDistanceOptions,
    alongRouteModeOptions,
    createAlongRouteController
} from './alongRouteController.js';
import { t } from '../i18n/index.js';

const MAX_CATEGORIES = 200;

function buildLabels() {
    return {
        title: t('map:alongRoute.title'),
        subtitle: t('map:alongRoute.subtitle'),
        close: t('map:alongRoute.closeLabel'),
        shareLink: t('map:alongRoute.shareLinkLabel'),
        shareLinkPlaceholder: t('map:alongRoute.shareLinkPlaceholder'),
        travelMode: t('map:alongRoute.travelMode'),
        want: t('map:alongRoute.wantLabel'),
        wantPlaceholder: t('map:alongRoute.wantPlaceholder'),
        tags: t('map:alongRoute.tagsLabel'),
        tagSearch: t('map:alongRoute.tagSearchPlaceholder'),
        frequentTags: t('map:alongRoute.frequentTags'),
        matchingTags: t('map:alongRoute.matchingTags'),
        noMatchingTags: t('map:alongRoute.noMatchingTags'),
        maxDistance: t('map:alongRoute.maxDistance'),
        planAndSearch: t('map:alongRoute.planAndSearch'),
        selectRouteBelow: t('map:alongRoute.selectRouteBelow'),
        searching: t('map:alongRoute.searching'),
        refilter: t('map:alongRoute.refilter'),
        searchFailed: t('map:alongRoute.searchFailed'),
        pasteLinkFirst: t('map:alongRoute.pasteLinkFirst'),
        mapNotReady: t('map:alongRoute.mapNotReadyRetry'),
        chooseRouteFirst: t('map:alongRoute.chooseRouteFirst'),
        cancel: t('common:action.cancel'),
        ok: t('common:action.ok')
    };
}

/** 分类目录按“常用在前、名字稳定”整理；原生只按输入过滤，不再改排序规则。 */
export function buildAlongRouteCategories(categories) {
    return (Array.isArray(categories) ? categories : [])
        .filter((category) => category && typeof category.name === 'string' && category.name.trim())
        .slice(0, MAX_CATEGORIES)
        .map((category) => ({
            name: category.name.trim().slice(0, 24),
            common: !!category.is_common,
            order: Number(category.sort_order) || 0
        }));
}

export default function useNativeAlongRoute({
    enabled,
    mapRef,
    backendUrl,
    themeColor,
    themeSecondary,
    dark,
    isNarrow,
    onResults,
    onSelectPlace,
    onUnavailable
}) {
    const [active, setActive] = useState(false);
    const sessionRef = useRef(null);
    const controllerRef = useRef(null);
    const generationRef = useRef(0);
    const openingRef = useRef(false);
    const latest = useRef({});
    latest.current = { onResults, onSelectPlace, onUnavailable, themeColor, themeSecondary, dark, isNarrow, backendUrl, mapRef };

    const finish = useCallback((selectedPlace) => {
        const controller = controllerRef.current;
        controllerRef.current = null;
        sessionRef.current = null;
        openingRef.current = false;
        controller?.reset();
        setActive(false);
        if (selectedPlace) latest.current.onSelectPlace?.(selectedPlace);
    }, []);

    const close = useCallback(() => {
        generationRef.current += 1;
        openingRef.current = false;
        const session = sessionRef.current;
        sessionRef.current = null;
        session?.stop();
        const controller = controllerRef.current;
        controllerRef.current = null;
        controller?.reset();
        setActive(false);
    }, []);

    const open = useCallback(async () => {
        if (!enabled || !latest.current.mapRef?.current) return false;
        if (sessionRef.current || openingRef.current) return false;
        openingRef.current = true;
        const generation = ++generationRef.current;
        setActive(true);
        try {
            const controller = createAlongRouteController({
                mapRef: latest.current.mapRef,
                backendUrl: latest.current.backendUrl,
                themeColor: latest.current.themeColor,
                themeSecondary: latest.current.themeSecondary,
                isNarrow: latest.current.isNarrow,
                onResults: (results) => latest.current.onResults?.(results)
            });
            controllerRef.current = controller;
            let categories = [];
            try {
                // 分类目录只影响标签建议：接口迟迟不返回时先空着打开面板，不阻塞顺路查询
                categories = await Promise.race([
                    fetchCategories(latest.current.backendUrl),
                    new Promise((resolve) => setTimeout(() => resolve([]), 1500))
                ]);
            } catch { /* 分类不可用时仍可搜索 */ }
            if (generation !== generationRef.current) return false;
            const snapshot = {
                theme: { primary: latest.current.themeColor || '#E2789F', dark: !!latest.current.dark },
                labels: buildLabels(),
                modes: alongRouteModeOptions(),
                distances: alongRouteDistanceOptions(),
                categories: buildAlongRouteCategories(categories),
                values: { url: '', mode: 'driving', query: '', categories: [], corridorMeters: 1000 }
            };
            const { registerPlugin } = await import('@capacitor/core');
            if (generation !== generationRef.current) return false;
            const session = createNativeAlongRouteSession(registerPlugin('NativeAlongRoute'), snapshot, {
                onSubmit: async (values) => {
                    try {
                        const result = await controller.submit(values);
                        return result ? { ok: true, state: result.state } : { ok: false, message: t('map:alongRoute.searchFailed') };
                    } catch (error) {
                        return { ok: false, message: error?.message || t('map:alongRoute.searchFailed') };
                    }
                },
                onChooseRoute: async (index, values) => {
                    try {
                        const result = await controller.choose(index, values);
                        return result ? { ok: true, state: result.state } : { ok: false, message: t('map:alongRoute.chooseRouteFailed') };
                    } catch (error) {
                        return { ok: false, message: error?.message || t('map:alongRoute.chooseRouteFailed') };
                    }
                },
                onSelectPlace: (placeId) => finish(controller.getPlace(placeId)),
                onClose: () => finish(),
                onError: () => {
                    if (generation !== generationRef.current) return;
                    finish();
                    latest.current.onUnavailable?.();
                }
            });
            if (generation !== generationRef.current) { session.stop(); return false; }
            sessionRef.current = session;
            await session.start();
            return true;
        } catch (error) {
            if (generation === generationRef.current) {
                finish();
                latest.current.onUnavailable?.(error);
            }
            return false;
        } finally {
            openingRef.current = false;
        }
    }, [enabled, finish]);

    useEffect(() => () => {
        generationRef.current += 1;
        sessionRef.current?.stop();
        sessionRef.current = null;
        controllerRef.current?.reset();
        controllerRef.current = null;
    }, []);

    return { active, open, close };
}
