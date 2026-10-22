import { useCallback, useEffect, useRef, useState } from 'react';
import { exhibitionVenue } from './exhibition';
import { t } from '../i18n/index.js';
import './marker-motion.css';

// 与地图锚定卡片相同：关闭钮上按下时不让地图开始拖动，click 照常触发
const STOP_EVENTS = ['mousedown', 'touchstart', 'pointerdown', 'dblclick'];

function createPinContent(label, onClose) {
    const root = document.createElement('div');
    root.className = 'fm-exhibition-venue';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', t('map:exhibition.venuePin', { location: label }));
    const tag = document.createElement('span');
    tag.className = 'fm-exhibition-venue__label';
    const name = document.createElement('span');
    name.className = 'fm-exhibition-venue__name';
    name.textContent = label;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fm-exhibition-venue__close';
    close.title = t('map:exhibition.hideVenue');
    close.setAttribute('aria-label', t('map:exhibition.hideVenue'));
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'close';
    close.append(icon);
    const stop = (event) => event.stopPropagation();
    STOP_EVENTS.forEach((type) => close.addEventListener(type, stop, { passive: true }));
    close.addEventListener('click', (event) => {
        event.stopPropagation();
        onClose();
    });
    tag.append(name, close);
    const pin = document.createElement('span');
    pin.className = 'fm-exhibition-venue__pin';
    pin.setAttribute('aria-hidden', 'true');
    root.append(tag, pin);
    return root;
}

/**
 * 展会地点的临时图钉：点展会面板里的地址后出现。点标签上的关闭钮、点地图空白处，
 * 或展会撤下 / 换了地点时消失。keepOnMapClick 为真时（添加地点、已选中地点）地图点按留给它们，不收起图钉。
 * 返回 show(venue)。
 */
export default function useExhibitionVenuePin({ mapRef, mapReady, exhibition, keepOnMapClick = false }) {
    const [shownKey, setShownKey] = useState(null);
    const keepOnMapClickRef = useRef(keepOnMapClick);
    keepOnMapClickRef.current = keepOnMapClick;
    const venue = exhibitionVenue(exhibition);
    const active = venue && venue.key === shownKey ? venue : null;
    const lat = active?.lat;
    const lng = active?.lng;
    const label = active?.label;

    useEffect(() => {
        const map = mapRef?.current;
        if (!mapReady || !map || !window.AMap || lat == null || lng == null) return undefined;
        const hide = () => setShownKey(null);
        const marker = new window.AMap.Marker({
            position: [lng, lat],
            content: createPinContent(label, hide),
            anchor: 'bottom-center',
            bubble: false,
            zIndex: 2900
        });
        const handleMapClick = (event) => {
            if (keepOnMapClickRef.current || (event?.target && event.target !== map)) return;
            hide();
        };
        marker.setMap(map);
        map.on('click', handleMapClick);
        return () => {
            map.off('click', handleMapClick);
            marker.setMap(null);
        };
    }, [mapRef, mapReady, lat, lng, label]);

    return useCallback((next) => setShownKey(next?.key || null), []);
}
