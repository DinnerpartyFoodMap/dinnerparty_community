import React, { useEffect, useRef, useState } from 'react';
import { loadCompanionPack } from './companionPack';
import { DEFAULT_COMPANION, DEFAULT_COMPANION_MODEL, DEFAULT_COMPANION_PREVIEW } from './defaultCompanion';
import { t } from '../i18n';
import './companion.css';

const builtInModel = `${import.meta.env.BASE_URL}${DEFAULT_COMPANION_MODEL}`;
const builtInPreview = `${import.meta.env.BASE_URL}${DEFAULT_COMPANION_PREVIEW}`;

/**
 * mood：'aloft' 时飞在空中的姿态（抬头、略向后仰），null 为平常。只在 Live2D 动起来时有效。
 * onScene(scene | null)：Live2D 就绪 / 卸载时交出场景（loop / play / face / setMood），底栏小伙伴由状态机控制动作；
 * reactToFeed：饱食度上涨时自己点头冒爱心（观察屋里用；底栏由状态机庆祝，传 false）。
 */
export default function CompanionFigure({ backendUrl, token, companion, showStatus = false, mood = null, onScene = null, reactToFeed = true }) {
    const container = useRef(null);
    const scene = useRef(null);
    const moodRef = useRef(mood);
    moodRef.current = mood;
    const onSceneRef = useRef(onScene);
    onSceneRef.current = onScene;
    const last = useRef(companion.satiety);
    const [loading, setLoading] = useState(false);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState(false);
    const [fed, setFed] = useState(false);
    const [retry, setRetry] = useState(0);
    const id = companion.active || DEFAULT_COMPANION;
    const isDefault = id === DEFAULT_COMPANION;

    useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        setLoading(!isDefault);
        setReady(false);
        setError(false);
        const source = isDefault ? Promise.resolve(builtInModel) : loadCompanionPack(backendUrl, token, id, { signal });
        Promise.all([source, import('./live2dScene')]).then(async ([url, { mountLive2D }]) => {
            if (signal.aborted || !container.current) return;
            const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const stage = await mountLive2D(container.current, url, {
                signal, reducedMotion, verifyColors: isDefault,
                onContextLost: () => setReady(false),
                onContextRestored: () => setRetry(count => count + 1)
            });
            if (signal.aborted) { stage?.destroy(); return; }
            scene.current = stage;
            stage?.setMood(moodRef.current);
            if (stage) onSceneRef.current?.(stage);
            setReady(!!stage);
        }).catch(() => { if (!signal.aborted && !isDefault) setError(true); }).finally(() => {
            if (!signal.aborted) setLoading(false);
        });
        return () => {
            controller.abort();
            if (scene.current) onSceneRef.current?.(null);
            scene.current?.destroy();
            scene.current = null;
        };
    }, [backendUrl, token, id, isDefault, retry]);

    useEffect(() => {
        scene.current?.setMood(mood);
    }, [mood]);

    useEffect(() => {
        const previous = last.current;
        last.current = companion.satiety;
        if (!reactToFeed || companion.satiety <= previous) { setFed(false); return undefined; }
        scene.current?.feed();
        setFed(true);
        const timer = setTimeout(() => setFed(false), 1200);
        return () => clearTimeout(timer);
    }, [companion.satiety]);

    return <div className="fm-companion">
        <div className="fm-companion__stage">
            {!ready && <img className="fm-companion__drawing" src={builtInPreview} alt="" />}
            <div className="fm-companion__canvas" ref={container} aria-hidden="true" style={{ visibility: ready ? 'visible' : 'hidden' }} />
            {fed && <span className="fm-companion__heart" title={t('companion:fed')} aria-hidden="true">♥</span>}
        </div>
        {showStatus && loading && <p role="status">{t('companion:loadingPack')}</p>}
        {showStatus && error && <button className="fm-companion__retry" type="button" onClick={() => setRetry((count) => count + 1)}>{t('companion:packError')}</button>}
    </div>;
}
