// 原生管理后台宿主：不渲染网页界面，只驱动原生页面与执行它交回的请求。
// 例外是展会场馆选点：原生页面引擎没有地图，「在地图上定位」先关闭原生后台，这里打开网页全屏选点，
// 存好后重新打开原生后台并直接进入场馆页（做法同地点表单的「在地图上修改位置」）。
import React, { useRef, useState } from 'react';
import useNativeAdmin from './useNativeAdmin';
import { FullScreenMapPicker } from '../map/MapView';
import { loadPlaceRegions } from '../places/placeRegions';
import { cityCenterOf, pickedCoordinates, placeVenue } from './venuePicking.js';
import { t } from '../i18n/index.js';

export default function NativeAdminHost(props) {
    const { backendUrl, token, onRequireAuth } = props;
    // picking：{ venue, center, open }，存在期间原生后台保持关闭；resume：选点结束后重新打开的位置与结果
    const [picking, setPicking] = useState(null);
    const [resume, setResume] = useState(null);
    const resumeSeq = useRef(0);
    // 一次选点只结束一次：选中后选点器还会关闭，两个回调都会来
    const settled = useRef(false);

    const finish = (result = {}) => {
        resumeSeq.current += 1;
        setResume({ seq: resumeSeq.current, section: 'venues', ...result });
        setPicking(null);
    };

    const onPickVenue = (venue) => {
        settled.current = false;
        setPicking({ venue, center: null, open: false });
        // 地区树要在选点地图挂载前就绪（地图只在挂载时读一次初始中心）；读不到就用默认视野
        loadPlaceRegions(backendUrl).catch(() => null).then((regions) => {
            setPicking((current) => (current && current.venue.id === venue.id
                ? { ...current, center: cityCenterOf(regions, venue.city), open: true }
                : current));
        });
    };

    useNativeAdmin({ ...props, onPickVenue, suspended: !!picking, resume });

    const pick = async (point) => {
        if (!picking || settled.current) return;
        settled.current = true;
        const venueId = picking.venue.id;
        setPicking((current) => (current ? { ...current, open: false } : current));
        const coordinates = pickedCoordinates(point);
        if (!coordinates) { finish(); return; }
        try {
            await placeVenue({ backendUrl, token, onRequireAuth }, venueId, coordinates);
            finish({ message: t('admin:venues.placedTip') });
        } catch (error) {
            finish({ error: error?.message || t('admin:venues.requestFailed') });
        }
    };

    const cancel = () => {
        if (settled.current) return;
        settled.current = true;
        finish();
    };

    return <FullScreenMapPicker open={!!picking?.open} title={t('admin:venues.pickLocation')} context="venue"
        center={picking?.center || null}
        backendUrl={backendUrl} token={token} isAuthenticated={!!token} onRequireAuth={onRequireAuth}
        onPickPlace={pick} onPickPoint={pick} onClose={cancel} />;
}
