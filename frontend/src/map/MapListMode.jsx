import React, { useRef, useState } from 'react';
import ScrollableView from '../components/layout/ScrollableView';
import AnchoredPopover from '../components/overlay/AnchoredPopover';
import { MapScopeMenu, radiusText } from './MapCenterMenu';
import PlaceListView from '../places/PlaceListView';
import { t } from '../i18n/index.js';
import '../places/placeList.css';


/**
 * 地图的列表模式：列表 / 地图切换按钮打开后盖在地图上（工具栏与浮动按钮仍在上面）。
 * 标签 / 人均与地图共用同一份筛选；中心与距离合成一个无边框按钮（“我的位置 · 3 公里内”），点开后在同一个菜单里选：
 * 中心默认是定位到的位置（还没定位时是打开列表时的地图中心），也可以在全屏地图上自己选（与修改地点位置同一个选点界面）。
 * 点列表里的地点回到地图并打开它；hidden 时（从列表打开的地点卡片还开着）列表保留在下面，关掉卡片后原样回来。
 */
export default function MapListMode({ backendUrl, token, filter, locatedCenter, getMapCenter, onPickCenter, onOpenPlace, hidden = false, insets = {} }) {
    const [radiusKm, setRadiusKm] = useState(3);
    // 'auto'：定位到的位置，没定位时是地图中心；'map'：地图中心；'custom'：在地图上选的点
    const [centerChoice, setCenterChoice] = useState('auto');
    const [customCenter, setCustomCenter] = useState(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const buttonRef = useRef(null);
    // 没定位时用打开列表那一刻的地图中心，之后移动地图不影响
    const [mapCenter] = useState(() => getMapCenter?.() || null);
    const source = centerChoice === 'custom' && customCenter ? 'custom' : (centerChoice !== 'map' && locatedCenter ? 'location' : 'map');
    const center = source === 'custom' ? customCenter : (source === 'location' ? locatedCenter : mapCenter);
    const distance = radiusKm && center ? { center, radiusKm } : null;

    const pickCenter = () => {
        setMenuOpen(false);
        onPickCenter?.(center, (point) => {
            setCustomCenter(point);
            setCenterChoice('custom');
        });
    };
    const centerLabel = source === 'custom' ? t('places:list.center.custom') : source === 'location' ? t('places:list.center.location') : t('places:list.center.map');
    const centerOptions = [
        locatedCenter && { id: 'location', label: t('places:list.center.location'), icon: 'my_location', select: () => setCenterChoice('auto') },
        { id: 'map', label: t('places:list.center.map'), icon: 'map', select: () => setCenterChoice('map') },
        customCenter && { id: 'custom', label: t('places:list.center.custom'), icon: 'location_on', select: () => setCenterChoice('custom') }
    ].filter(Boolean);

    return (
        <div
            className="fm-map-list"
            data-map-occluder={hidden ? undefined : ''}
            style={{
                position: 'absolute', left: 0, right: 0, top: 'calc(-1 * var(--map-list-safe-top, 0px))', bottom: 0, zIndex: 1690,
                background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
                boxSizing: 'border-box', paddingTop: 'var(--map-list-safe-top, 0px)',
                // 隐藏时不卸载：滚动位置、距离与中心都留着（visibility 同时让它离开焦点顺序与读屏）
                visibility: hidden ? 'hidden' : 'visible'
            }}
        >
            {/* 背景覆盖 iOS 状态栏，滚动内容仍裁在安全区下方。 */}
            <ScrollableView className="fm-map-list__scroll" style={{ height: '100%', boxSizing: 'border-box', padding: `${insets.top ?? 16}px 16px ${insets.bottom ?? 24}px` }}>
                <div className="fm-place-list">
                    <h2 className="fm-map-list__title">{t('places:list.title')}</h2>
                    <PlaceListView backendUrl={backendUrl} token={token} filter={filter} distance={distance} onOpenPlace={onOpenPlace}>
                        <div className="fm-map-list__distance">
                            <button
                                ref={buttonRef}
                                type="button"
                                className="fm-map-list__scope fm-pressable"
                                onClick={() => setMenuOpen((open) => !open)}
                                aria-haspopup="menu"
                                aria-expanded={menuOpen}
                                aria-label={t('places:list.scopeLabel', { center: centerLabel, distance: radiusText(radiusKm) })}
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">{source === 'location' ? 'my_location' : source === 'custom' ? 'location_on' : 'map'}</span>
                                <span className="fm-map-list__scope-text">{t('places:list.scope', { center: centerLabel, distance: radiusText(radiusKm) })}</span>
                                <span className="material-symbols-outlined" aria-hidden="true">expand_more</span>
                            </button>
                            <AnchoredPopover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={buttonRef} placement="bottom-start" label={t('places:list.center.pickTitle')} style={{ minWidth: 240 }}>
                                <MapScopeMenu options={centerOptions} selected={source} onPickCenter={pickCenter}
                                    radiusKm={radiusKm} onRadiusChange={km => { setRadiusKm(km); setMenuOpen(false); }} />
                            </AnchoredPopover>
                        </div>
                    </PlaceListView>
                </div>
            </ScrollableView>
        </div>
    );
}
