import React, { useEffect, useRef, useState } from 'react';
import Button from "../../components/primitives/Button";
import ResponsivePanel from "../../components/overlay/ResponsivePanel";
import MotionSurface from "../../components/overlay/MotionSurface";
import { useLayoutPolicy } from "../../motion/MotionProvider";
import { normalizeImageUrl } from "../../map/utils";
import { imageThumbnailUrl } from "../../platform/runtimeConfig";
import PlaceDiaryList from "../../journey/PlaceDiaryList";
import SkinIcon from "../../skins/SkinIcon";
import { t, tx } from "../../i18n/index.js";
import { tierForAverage, tierLabel, formatAverage, summaryText } from "../rating";

/** 地点的外观 / 菜单图片字段（JSON 字符串或数组）→ 完整地址列表 */
export function parseImages(value) {
    try {
        const images = Array.isArray(value) ? value : (value ? JSON.parse(value) : []);
        return Array.isArray(images) ? images.map(normalizeImageUrl) : [];
    } catch (e) {
        return [];
    }
}

// 地点详情：宽屏为右侧信息板（非模态，地图仍可操作），窄屏为可在中/全屏两档停靠的底部面板。
// 图片预览是嵌套浮层：返回键先关闭预览，再关闭详情。
export default function PlaceDetailPanel({ open = true, place, onClose, onNavigate, focus = null, backendUrl, rating = null, onOpenRating }) {
    const layout = useLayoutPolicy();
    return (
        <ResponsivePanel
            open={open && !!place}
            onClose={onClose}
            title={place ? place.name : t('map:placeDetail.title')}
            label={place ? t('map:placeDetail.titleNamed', { name: place.name }) : t('map:placeDetail.title')}
            kind="place-detail"
            desktop="side-right"
            mobile="sheet"
            modal={layout.sheet}
            closeLabel={t('map:placeDetail.close')}
            width="350px"
            sideInset={64}
            sheetHeight="calc(100% - 56px)"
            snap="half"
            bodyStyle={{ padding: 0 }}
        >
            {place && <PlaceDetailBody place={place} onNavigate={onNavigate} isMobile={layout.sheet} focus={focus} backendUrl={backendUrl} rating={rating} onOpenRating={onOpenRating} />}
        </ResponsivePanel>
    );
}

function PlaceDetailBody({ place, onNavigate, isMobile, focus, backendUrl, rating, onOpenRating }) {
    const [preview, setPreview] = useState(null);
    const diariesRef = useRef(null);
    // 从地点小卡的「相关日记」进入时，直接定位到日记区域
    useEffect(() => {
        if (focus !== 'diaries') return undefined;
        const timer = setTimeout(() => diariesRef.current && diariesRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' }), 260);
        return () => clearTimeout(timer);
    }, [focus, place && place.id]);
    const exteriorImages = parseImages(place.exterior_images);
    const menuImages = parseImages(place.menu_images);

    const renderImageGroup = (title, images) => images.length > 0 && (
        <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--color-text-secondary)' }}>{title}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {images.map((url, index) => (
                    <button
                        key={`${url}-${index}`}
                        type="button"
                        onClick={(event) => setPreview({ url, rect: event.currentTarget.getBoundingClientRect() })}
                        aria-label={t('map:placeDetail.zoomImage', { title, index: index + 1 })}
                        style={{ padding: 0, border: 0, background: 'transparent', cursor: 'zoom-in', display: 'block', width: '100%' }}
                    >
                        <img src={imageThumbnailUrl(url, 800)} alt={`${title} ${index + 1}`} style={{ width: '100%', borderRadius: 8, display: 'block' }} loading="lazy" />
                    </button>
                ))}
            </div>
        </div>
    );

    return (
        <>
            <div style={{ padding: isMobile ? '0 16px 12px' : '12px 20px', borderBottom: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, color: 'var(--color-text-secondary)', fontSize: 13 }}>
                    <span>{place.category || t('common:label.uncategorized')}</span>
                    {place.per_person_cost != null && <span>{tx('map:placeDetail.perPersonCost', { per_person_cost: place.per_person_cost })}</span>}
                </div>
                {rating && onOpenRating && <RatingLine rating={rating} onOpen={onOpenRating} />}
                {onNavigate && (
                    <Button
                        themeAware
                        onClick={() => onNavigate(place)}
                        style={{ width: isMobile ? '100%' : 'auto', marginTop: 12, minHeight: 42, padding: '8px 16px', fontWeight: 700 }}
                    >
                        <span className="material-symbols-outlined" style={{ fontSize: 19, verticalAlign: 'middle', marginRight: 5 }}>navigation</span>
                        {t('map:placeDetail.navigateHere')}
                    </Button>
                )}
            </div>

            <div style={{ padding: isMobile ? 16 : 20, paddingBottom: 20 }}>
                <div style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{t('map:common.label.description')}</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{place.description || t('map:placeDetail.noDescription')}</div>
                    {place.address && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--color-text-secondary)' }}>{place.address}</div>}
                </div>
                {/* 相关公开日记：放在基本信息之后、长图片列表之前；日记照片不混入外观/菜单图库 */}
                <PlaceDiaryList place={place} sectionRef={diariesRef} base={backendUrl} />
                {renderImageGroup(t('map:placeDetail.exteriorImages'), exteriorImages)}
                {renderImageGroup(t('common:label.menu'), menuImages)}
                {exteriorImages.length === 0 && menuImages.length === 0 && (
                    <div style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', fontSize: 13, marginTop: 24, textAlign: 'center' }}>{t('map:placeDetail.noImages')}</div>
                )}
            </div>

            <ImagePreview preview={preview} onClose={() => setPreview(null)} />
        </>
    );
}

/** 评价一行：大家的评价（与自己的评价），点开评价面板 */
function RatingLine({ rating, onOpen }) {
    const { summary, mine } = rating;
    const tier = tierForAverage(summary.average);
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={t('map:rating.card.openLabel', { summary: summaryText(summary) })}
            title={t('map:placeDetail.rateLabel')}
            className="fm-pressable"
            style={{ marginTop: 10, padding: 0, border: 0, background: 'transparent', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, cursor: 'pointer', textAlign: 'left' }}
        >
            <SkinIcon slot={tier ? `rating.${tier.key}` : 'rating.none'} size={20}>
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20, color: tier ? tier.tone : 'var(--color-text-muted)' }}>{tier ? tier.icon : 'rate_review'}</span>
            </SkinIcon>
            <span>
                {summary.count > 0
                    ? tx('map:rating.card.summary', { tier: <strong style={{ color: tier.tone }}>{tierLabel(tier)}</strong>, average: formatAverage(summary.average), count: summary.count })
                    : t('map:rating.summary.none')}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: mine ? mine.tone : 'var(--theme-primary)' }}>
                {mine ? t('map:rating.card.mine', { tier: tierLabel(mine) }) : t('map:rating.card.rateNow')}
            </span>
        </button>
    );
}

/** 图片预览：从缩略图位置展开；缩略图不可见时渐变放大。 */
function ImagePreview({ preview, onClose }) {
    const from = preview && preview.rect;
    const visible = from && from.bottom > 0 && from.top < window.innerHeight && from.width > 0;
    const variants = visible ? {
        initial: { opacity: 0, scale: Math.max(0.2, from.width / Math.min(window.innerWidth, 900)), x: from.left + from.width / 2 - window.innerWidth / 2, y: from.top + from.height / 2 - window.innerHeight / 2 },
        animate: { opacity: 1, scale: 1, x: 0, y: 0, transition: { duration: 0.28, ease: [0.05, 0.7, 0.1, 1] } },
        exit: { opacity: 0, scale: 0.94, transition: { duration: 0.18 } }
    } : undefined;
    return (
        <MotionSurface
            show={!!preview}
            portal
            preset="preview"
            variants={variants}
            layer="center"
            backdrop
            backdropStyle={{ background: 'rgba(0, 0, 0, 0.88)' }}
            overlay={{ onClose, modal: true, kind: 'image-preview', label: t('map:placeDetail.imagePreview') }}
            aria-label={t('map:placeDetail.imagePreview')}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', maxWidth: '100%', maxHeight: '100%', outline: 'none' }}
        >
            {preview && (
                <div style={{ position: 'relative' }}>
                    <img
                        src={preview.url}
                        alt={t('map:placeDetail.imagePreview')}
                        onClick={onClose}
                        style={{ maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(var(--app-height, 100vh) - 96px)', objectFit: 'contain', borderRadius: 8, userSelect: 'none', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}
                    />
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('map:placeDetail.closePreview')}
                        className="fm-pressable"
                        style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.5)', color: '#fff', fontSize: 26, cursor: 'pointer' }}
                    >×</button>
                </div>
            )}
        </MotionSurface>
    );
}
