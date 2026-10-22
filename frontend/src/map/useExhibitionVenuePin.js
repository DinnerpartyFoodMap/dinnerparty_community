import { useCallback, useEffect, useState } from 'react';
import { exhibitionVenue } from './exhibition';
import { t } from '../i18n/index.js';
import './marker-motion.css';

function createPinContent(label) {
    const root = document.createElement('div');
    root.className = 'fm-exhibition-venue';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', t('map:exhibition.venuePin', { location: label }));
    const text = document.createElement('span');
    text.className = 'fm-exhibition-venue__label';
    text.textContent = label;
    const pin = document.createElement('span');
    pin.className = 'fm-exhibition-venue__pin';
    root.append(text, pin);
    return root;
}

/**
 * 展会地点的临时图钉：点展会面板里的地址（或原生面板的“查看位置”）后出现，
 * 展会撤下或换了地点时消失。返回 show(venue)。
 */
export default function useExhibitionVenuePin({ mapRef, mapReady, exhibition }) {
    const [shownKey, setShownKey] = useState(null);
    const venue = exhibitionVenue(exhibition);
    const active = venue && venue.key === shownKey ? venue : null;
    const lat = active?.lat;
    const lng = active?.lng;
    const label = active?.label;

    useEffect(() => {
        const map = mapRef?.current;
        if (!mapReady || !map || !window.AMap || lat == null || lng == null) return undefined;
        const marker = new window.AMap.Marker({
            position: [lng, lat],
            content: createPinContent(label),
            anchor: 'bottom-center',
            title: label,
            bubble: true,
            zIndex: 2900
        });
        marker.setMap(map);
        return () => marker.setMap(null);
    }, [mapRef, mapReady, lat, lng, label]);

    return useCallback((next) => setShownKey(next?.key || null), []);
}
