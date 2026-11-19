import React, { useEffect, useRef, useState } from 'react';
import { loadCompanionPack } from './companionPack';
import { DEFAULT_COMPANION } from './useCompanion';
import { t } from '../i18n';
import './companion.css';

const builtIn = `${import.meta.env.BASE_URL}companions/stick-figure/stick-figure.model3.json`;
const drawing = `${import.meta.env.BASE_URL}companions/stick-figure/preview.svg`;

export function StickFigureDrawing() {
    return <img className="fm-companion__drawing" src={drawing} alt="" />;
}

export default function CompanionFigure({ backendUrl, token, companion, showStatus = false }) {
    const container = useRef(null);
    const scene = useRef(null);
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
        const source = isDefault ? Promise.resolve(builtIn) : loadCompanionPack(backendUrl, token, id, { signal });
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
            setReady(!!stage);
        }).catch(() => { if (!signal.aborted && !isDefault) setError(true); }).finally(() => {
            if (!signal.aborted) setLoading(false);
        });
        return () => {
            controller.abort();
            scene.current?.destroy();
            scene.current = null;
        };
    }, [backendUrl, token, id, isDefault, retry]);

    useEffect(() => {
        const previous = last.current;
        last.current = companion.satiety;
        if (companion.satiety <= previous) { setFed(false); return undefined; }
        scene.current?.feed();
        setFed(true);
        const timer = setTimeout(() => setFed(false), 1200);
        return () => clearTimeout(timer);
    }, [companion.satiety]);

    return <div className="fm-companion">
        <div className="fm-companion__stage">
            {!ready && <StickFigureDrawing />}
            <div className="fm-companion__canvas" ref={container} aria-hidden="true" style={{ visibility: ready ? 'visible' : 'hidden' }} />
            {fed && <span className="fm-companion__heart" title={t('companion:fed')} aria-hidden="true">♥</span>}
        </div>
        {showStatus && loading && <p role="status">{t('companion:loadingPack')}</p>}
        {showStatus && error && <button className="fm-companion__retry" type="button" onClick={() => setRetry((count) => count + 1)}>{t('companion:packError')}</button>}
    </div>;
}
