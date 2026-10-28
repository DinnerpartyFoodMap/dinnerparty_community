import React, { useState } from 'react';
import ScrollableView from '../components/layout/ScrollableView';
import Button from '../components/primitives/Button';
import PlaceListView, { RADIUS_OPTIONS_KM } from '../places/PlaceListView';
import { t } from '../i18n/index.js';
import '../places/placeList.css';

/**
 * 地图的列表模式：列表 / 地图切换按钮打开后盖在地图上（工具栏与浮动按钮仍在上面）。
 * 标签 / 人均与地图共用同一份筛选；另有距离下拉框，中心默认是定位到的位置（还没定位时是打开列表时的地图中心），
 * 也可以在全屏地图上自己选（与修改地点位置同一个选点界面）。点列表里的地点回到地图并打开它。
 */
export default function MapListMode({ backendUrl, token, filter, locatedCenter, getMapCenter, onPickCenter, onOpenPlace, insets = {} }) {
    const [radiusKm, setRadiusKm] = useState(null);
    const [customCenter, setCustomCenter] = useState(null);
    // 没定位时用打开列表那一刻的地图中心，之后移动地图不影响
    const [mapCenter] = useState(() => getMapCenter?.() || null);
    const center = customCenter || locatedCenter || mapCenter;
    const source = customCenter ? 'custom' : (locatedCenter ? 'location' : 'map');
    const distance = radiusKm && center ? { center, radiusKm } : null;

    const pickCenter = () => onPickCenter?.(center, (point) => setCustomCenter(point));

    return (
        <ScrollableView
            className="fm-map-list"
            data-map-occluder=""
            style={{
                position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 1690,
                background: 'var(--color-bg-base)', color: 'var(--color-text-primary)', overflowY: 'auto',
                boxSizing: 'border-box', padding: `${insets.top ?? 16}px 16px ${insets.bottom ?? 24}px`
            }}
        >
            <div className="fm-place-list">
                <h2 className="fm-map-list__title">{t('places:list.title')}</h2>
                <PlaceListView backendUrl={backendUrl} token={token} filter={filter} distance={distance} onOpenPlace={onOpenPlace}>
                    <div className="fm-map-list__distance">
                        <label className="fm-map-list__radius">
                            <span>{t('places:list.distanceLabel')}</span>
                            <select value={radiusKm ?? ''} onChange={(event) => setRadiusKm(event.target.value ? Number(event.target.value) : null)}>
                                <option value="">{t('places:list.distanceAny')}</option>
                                {RADIUS_OPTIONS_KM.map((km) => <option key={km} value={km}>{t('places:list.distanceWithin', { km })}</option>)}
                            </select>
                        </label>
                        {radiusKm && (
                            <span className="fm-map-list__center">
                                <span className="material-symbols-outlined" aria-hidden="true">{source === 'location' ? 'my_location' : 'location_on'}</span>
                                {source === 'custom' ? t('places:list.center.custom') : (source === 'location' ? t('places:list.center.location') : t('places:list.center.map'))}
                                <Button themeAware onClick={pickCenter} style={{ padding: '4px 10px', fontSize: 13 }}>{t('places:list.center.change')}</Button>
                                {customCenter && (
                                    <Button themeAware onClick={() => setCustomCenter(null)} style={{ padding: '4px 10px', fontSize: 13 }}>
                                        {locatedCenter ? t('places:list.center.useLocation') : t('places:list.center.useMap')}
                                    </Button>
                                )}
                            </span>
                        )}
                    </div>
                </PlaceListView>
            </div>
        </ScrollableView>
    );
}
