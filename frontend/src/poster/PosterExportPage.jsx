import React, { useEffect, useMemo, useRef, useState } from 'react';
import Button from "../components/primitives/Button";
import TextArea from "../components/forms/TextArea";
import TextInput from "../components/forms/TextInput";
import MapView from "../map/MapView";
import MotionSurface from "../components/overlay/MotionSurface";
import FullScreenMapContent from "../components/layout/FullScreenMapContent";
import { useTips } from "../components/feedback/Tips";
import useDarkMode from "../theme/useDarkMode";
import { createMapPoster } from "./rendering/posterCanvas";
import ScrollableView from "../components/layout/ScrollableView";
import { buildPublicUrl } from "../platform/runtimeConfig";
import { saveImageBlob } from "../platform/share";
import { t, tx } from "../i18n/index.js";

function pageStyle(dark) {
    return {
        height: '100%',
        minHeight: 0,
        background: 'var(--color-bg-base)',
        color: 'var(--color-text-primary)',
        padding: 20,
        boxSizing: 'border-box'
    };
}

function cardStyle(dark) {
    return {
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
        boxShadow: '0 8px 24px var(--color-glow)',
        padding: 20
    };
}

function getPlaceKey(place) {
    if (place?.id !== undefined && place?.id !== null && String(place.id) !== '') {
        return `id:${place.id}`;
    }

    const longitude = Number(place?.longitude);
    const latitude = Number(place?.latitude);
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
        return `coord:${longitude.toFixed(6)},${latitude.toFixed(6)}`;
    }

    return `name:${String(place?.name || place?.address || '').trim()}`;
}

function getPlaceName(place) {
    return String(place?.name || place?.address || t('common:label.unnamedPlace')).trim();
}

function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob !== 'function') {
            fetch(canvas.toDataURL('image/png')).then((res) => res.blob()).then(resolve, reject);
            return;
        }
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('poster:page.renderFailed')))), 'image/png');
    });
}

export default function PosterExportPage({ backendUrl, token, isAuth, onRequireAuth, onMapPickerOpenChange }) {
    const dark = useDarkMode();
    const showTip = useTips();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [selectedPlaces, setSelectedPlaces] = useState([]);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState('');
    const [previewCanvas, setPreviewCanvas] = useState(null);
    const [previewKey, setPreviewKey] = useState('');
    const [previewing, setPreviewing] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [previewRetryKey, setPreviewRetryKey] = useState(0);
    const previewCanvasRef = useRef(null);
    const previewRequestRef = useRef(0);

    const selectedKeys = useMemo(() => new Set(selectedPlaces.map(getPlaceKey)), [selectedPlaces]);
    // 二维码始终指向公开 HTTPS 网页地址，未安装 App 的用户也能打开
    const posterQrValue = buildPublicUrl('/');
    const posterInputKey = useMemo(() => JSON.stringify({
        title: title.trim(),
        description: description.trim(),
        backendUrl,
        qrValue: posterQrValue,
        places: selectedPlaces.map((place) => ({
            key: getPlaceKey(place),
            name: getPlaceName(place),
            category: place?.category || '',
            longitude: place?.longitude,
            latitude: place?.latitude
        }))
    }), [title, description, selectedPlaces, backendUrl, posterQrValue]);
    const previewReady = !!previewCanvas && previewKey === posterInputKey;

    useEffect(() => {
        if (typeof onMapPickerOpenChange === 'function') {
            onMapPickerOpenChange(pickerOpen);
        }
    }, [pickerOpen, onMapPickerOpenChange]);

    useEffect(() => {
        return () => {
            if (typeof onMapPickerOpenChange === 'function') onMapPickerOpenChange(false);
        };
    }, [onMapPickerOpenChange]);

    useEffect(() => {
        const normalizedTitle = title.trim();
        const requestId = previewRequestRef.current + 1;
        previewRequestRef.current = requestId;

        if (!normalizedTitle || selectedPlaces.length === 0) {
            setPreviewCanvas(null);
            setPreviewKey('');
            setPreviewing(false);
            setPreviewError('');
            return undefined;
        }

        setPreviewing(true);
        setPreviewError('');
        const timer = window.setTimeout(async () => {
            try {
                const canvas = await createMapPoster({
                    title: normalizedTitle,
                    description: description.trim(),
                    places: selectedPlaces,
                    backendUrl,
                    qrValue: posterQrValue
                });
                if (previewRequestRef.current !== requestId) return;
                setPreviewCanvas(canvas);
                setPreviewKey(posterInputKey);
            } catch (previewGenerationError) {
                if (previewRequestRef.current !== requestId) return;
                setPreviewCanvas(null);
                setPreviewKey('');
                setPreviewError(previewGenerationError?.message || t('poster:page.previewFailed'));
            } finally {
                if (previewRequestRef.current === requestId) setPreviewing(false);
            }
        }, 500);

        return () => window.clearTimeout(timer);
    }, [posterInputKey, previewRetryKey, title, description, selectedPlaces, backendUrl, posterQrValue]);

    useEffect(() => {
        const visibleCanvas = previewCanvasRef.current;
        if (!visibleCanvas || !previewCanvas) return;
        const context = visibleCanvas.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, visibleCanvas.width, visibleCanvas.height);
        context.drawImage(previewCanvas, 0, 0, visibleCanvas.width, visibleCanvas.height);
    }, [previewCanvas]);

    const addSelectedPlace = (place) => {
        const key = getPlaceKey(place);
        if (!key || selectedKeys.has(key)) {
            showTip && showTip(t('poster:page.alreadyAdded'));
            return;
        }
        if (!Number.isFinite(Number(place?.longitude)) || !Number.isFinite(Number(place?.latitude))) {
            showTip && showTip(t('poster:page.missingCoordinates'));
            return;
        }
        setSelectedPlaces((items) => [...items, place]);
        showTip && showTip(t('poster:page.selected', { getPlaceName: getPlaceName(place) }));
    };

    const removeSelectedPlace = (place) => {
        const key = getPlaceKey(place);
        setSelectedPlaces((items) => items.filter((item) => getPlaceKey(item) !== key));
    };

    const exportPoster = async () => {
        const normalizedTitle = title.trim();
        if (!normalizedTitle) {
            setError(t('poster:page.titleRequired'));
            return;
        }
        if (selectedPlaces.length === 0) {
            setError(t('poster:page.placeRequired'));
            return;
        }
        if (!previewReady) {
            setError(t('poster:page.waitPreview'));
            return;
        }

        setExporting(true);
        setError('');
        try {
            const safeTitle = normalizedTitle.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) || t('poster:page.defaultFilename');
            // 网页：下载 PNG；App：打开系统面板，由用户选择“存储图像”（相册）或“存储到文件”
            const blob = await canvasToPngBlob(previewCanvas);
            const result = await saveImageBlob(blob, `${safeTitle}.png`, { title: safeTitle });
            if (result === 'failed') throw new Error(t('poster:page.saveFailed'));
            if (result !== 'cancelled') showTip && showTip(result === 'downloaded' ? t('poster:page.exported') : t('poster:page.handedToSystem'));
        } catch (exportError) {
            setError(exportError?.message || t('poster:page.exportFailed'));
        } finally {
            setExporting(false);
        }
    };

    return (
        <ScrollableView as="main" style={pageStyle(dark)}>
            <div style={{ maxWidth: 960, margin: '0 auto' }}>
                <div className="fm-legacy-page-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, marginTop: 50 }}>
                    <h2 style={{ margin: 0 }}>{t('poster:page.title')}</h2>
                </div>

                <div className="fm-page-card" style={cardStyle(dark)}>
                    <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
                        {t('poster:page.intro')}
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                <label htmlFor="poster-title" style={{ fontSize: 16, fontWeight: 600 }}>
                                    {t('poster:page.titleLabel')}
                                </label>
                                <TextInput
                                    id="poster-title"
                                    value={title}
                                    onChange={(event) => setTitle(event.target.value)}
                                    maxLength={60}
                                    required
                                />
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                <label htmlFor="poster-description" style={{ fontSize: 16, fontWeight: 600 }}>
                                    {t('poster:page.descriptionLabel')}
                                </label>
                                <TextArea
                                    id="poster-description"
                                    value={description}
                                    onChange={(event) => setDescription(event.target.value)}
                                    maxLength={240}
                                    rows={5}
                                    style={{
                                        borderRadius: 12,
                                        padding: 12
                                    }}
                                />
                            </div>
                        </div>

                        <section aria-labelledby="poster-place-heading" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between'
                            }}>
                                <h3 id="poster-place-heading" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t('poster:page.choosePlaces')}</h3>
                                <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                                    {tx('poster:page.selectedCount', { count: selectedPlaces.length })}
                                </span>
                            </div>

                            <div style={{
                                border: '1px solid var(--color-border)',
                                borderRadius: 12,
                                overflow: 'hidden',
                                background: 'var(--color-bg-surface)'
                            }}>
                                {selectedPlaces.length === 0 ? (
                                    <div style={{ padding: '22px 14px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                                        {t('poster:page.noPlaces')}
                                    </div>
                                ) : (
                                    selectedPlaces.map((place, index) => (
                                        <div
                                            key={getPlaceKey(place)}
                                            style={{
                                                padding: '11px 14px',
                                                display: 'flex',
                                                gap: 12,
                                                alignItems: 'center',
                                                borderBottom: index < selectedPlaces.length - 1 ? '1px solid var(--color-border)' : 'none'
                                            }}
                                        >
                                            <span style={{
                                                width: 28,
                                                height: 28,
                                                borderRadius: '50%',
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexShrink: 0,
                                                background: 'var(--theme-primary)',
                                                color: '#2B2533',
                                                fontSize: 12,
                                                fontWeight: 700
                                            }}>
                                                {index + 1}
                                            </span>
                                            <div style={{ minWidth: 0, flex: 1 }}>
                                                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getPlaceName(place)}</div>
                                                <div style={{ marginTop: 2, color: 'var(--color-text-secondary)', fontSize: 12 }}>
                                                    {place?.category || t('common:label.uncategorized')}
                                                    {place?.per_person_cost !== undefined && place?.per_person_cost !== null ? t('common:label.perPersonCost', { per_person_cost: place.per_person_cost }) : ''}
                                                </div>
                                            </div>
                                            <Button
                                                type="button"
                                                onClick={() => removeSelectedPlace(place)}
                                                aria-label={t('poster:page.removePlace', { name: getPlaceName(place) })}
                                                style={{ padding: '5px 9px', background: 'transparent', color: 'var(--color-danger)', border: '1px solid var(--color-danger)' }}
                                            >
                                                {t('common:action.remove')}
                                            </Button>
                                        </div>
                                    ))
                                )}
                            </div>

                            <div>
                                <Button type="button" onClick={() => setPickerOpen(true)} style={{ border: 0 }}>
                                    {t('poster:page.goPickOnMap')}
                                </Button>
                            </div>
                        </section>

                        <section aria-labelledby="poster-preview-heading" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between'
                            }}>
                                <h3 id="poster-preview-heading" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t('poster:page.preview')}</h3>
                                <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                                    {previewing ? t('poster:page.previewUpdating') : previewReady ? t('poster:page.previewReady') : t('poster:page.previewPending')}
                                </span>
                            </div>

                            <div style={{
                                border: '1px solid var(--color-border)',
                                borderRadius: 12,
                                overflow: 'hidden',
                                background: 'var(--color-bg-surface)'
                            }}>
                                <div style={{
                                    position: 'relative',
                                    aspectRatio: '16 / 9',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    overflow: 'hidden',
                                    background: 'var(--color-bg-overlay)'
                                }}>
                                    {previewCanvas ? (
                                        <canvas
                                            ref={previewCanvasRef}
                                            width={1600}
                                            height={900}
                                            aria-label={t('poster:page.previewLabel')}
                                            style={{ display: 'block', width: '100%', height: 'auto' }}
                                        />
                                    ) : (
                                        <div style={{
                                            padding: 24,
                                            textAlign: 'center',
                                            color: 'var(--color-text-secondary)',
                                            fontSize: 14
                                        }}>
                                            {previewError ? t('poster:page.previewUnavailable') : t('poster:page.previewHint')}
                                        </div>
                                    )}

                                    {previewing && (
                                        <div
                                            role="status"
                                            style={{
                                                position: 'absolute',
                                                inset: 0,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                background: 'rgba(15, 23, 42, 0.58)',
                                                color: '#fff',
                                                fontSize: 14
                                            }}
                                        >
                                            {t('poster:page.previewGenerating')}
                                        </div>
                                    )}
                                </div>

                                {!!previewError && (
                                    <div style={{
                                        padding: '10px 14px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: 12,
                                        color: 'var(--color-danger)',
                                        fontSize: 13
                                    }}>
                                        <span>{previewError}</span>
                                        <Button
                                            type="button"
                                            onClick={() => setPreviewRetryKey((value) => value + 1)}
                                            style={{ flexShrink: 0, background: 'transparent', color: 'var(--color-danger)' }}
                                        >
                                            {t('poster:page.retry')}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </section>

                        {!!error && <div role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Button
                                type="button"
                                onClick={exportPoster}
                                disabled={exporting || previewing || !previewReady}
                                style={{ border: 0 }}
                            >
                                {exporting ? t('poster:page.exporting') : previewing ? t('poster:page.generatingPreview') : t('poster:page.export')}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            {/* 全屏选点器：作为浮层从底部进入；返回键与 Escape 先关闭其中的弹层，再关闭选点器 */}
            <MotionSurface
                show={pickerOpen}
                portal
                preset="sheet"
                overlay={{ onClose: () => setPickerOpen(false), modal: true, kind: 'map-picker', label: t('common:action.pickOnMap') }}
                aria-label={t('common:action.pickOnMap')}
                style={{ position: 'absolute', inset: 0, background: 'var(--color-bg-base)', overflow: 'hidden' }}
            >
                    <FullScreenMapContent onBack={() => setPickerOpen(false)}>
                    <MapView
                        backendUrl={backendUrl}
                        token={token}
                        isAuthenticated={isAuth}
                        onRequireAuth={onRequireAuth}
                        onOpenDinnerCreate={() => { }}
                        onOpenDinners={() => { }}
                        pickerMode
                        pickerContext="poster"
                        pickedPlaces={selectedPlaces}
                        onPickPlace={addSelectedPlace}
                        onRemovePickedPlace={removeSelectedPlace}
                        onPickerClose={() => setPickerOpen(false)}
                    />
                    </FullScreenMapContent>
            </MotionSurface>
        </ScrollableView>
    );
}
