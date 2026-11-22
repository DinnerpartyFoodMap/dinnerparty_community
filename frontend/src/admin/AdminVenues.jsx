import React, { useEffect, useRef, useState } from 'react';
import Button from '../components/primitives/Button';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import { useAuth } from '../auth/AuthContext';
import { FullScreenMapPicker } from '../map/MapView';
import { loadPlaceRegions } from '../places/placeRegions';
import { t } from '../i18n/index.js';
import StateMessage from '../components/feedback/StateMessage';

// 场馆（denpawave → 饭联地图）：对端说「这个场馆该在地图上有一个点」，管理员在地图上落一个坐标。
// 待办只是 status='pending' 的那批，落点后同一行变成 placed 实体。
// 场馆不是地点：不建 Place，不写评分，不进搜索与随机推荐。全程不调用任何高德搜索，
// 见 backend/modules/venues/doc/README.md。

/**
 * 选点时地图的初始中心：用已有地点算出的地区树，按城市名找 bounds 的中心。
 * 零外部调用（不碰高德行政区查询）；城市还没被任何地点覆盖时返回 null，用地图默认视野。
 */
function cityCenterOf(regions, city) {
    const raw = String(city || '').trim();
    if (!raw) return null;
    // 对端可能只写「上海」，地区树里是「上海市」；去掉行政区后缀再比，避免静默退回默认视野。
    const bare = (value) => String(value || '').trim().replace(/(特别行政区|自治区|自治州|地区|省|市|县)$/u, '');
    const want = bare(raw);
    if (!want) return null;
    const matches = (value) => bare(value) === want || raw === String(value || '').trim();
    for (const province of regions || []) {
        const cityNode = (province.children || []).find((item) => matches(item.name));
        const node = cityNode || (matches(province.name) ? province : null);
        const bounds = node && node.bounds;
        if (Array.isArray(bounds) && bounds.length === 4 && bounds.every((value) => Number.isFinite(Number(value)))) {
            return { lat: (bounds[1] + bounds[3]) / 2, lng: (bounds[0] + bounds[2]) / 2 };
        }
    }
    return null;
}

/** 数据库时间是 UTC 的 “YYYY-MM-DD HH:MM:SS” */
function formatTime(value) {
    if (!value) return '';
    const date = new Date(`${String(value).replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AdminVenues({ backendUrl }) {
    const { token, onRequireAuth } = useAuth();
    const showTip = useTips();
    const confirm = useConfirm();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [reload, setReload] = useState(0);
    const [busyId, setBusyId] = useState(null);
    const [picking, setPicking] = useState(null);
    const [regions, setRegions] = useState(null);

    async function request(path, options = {}) {
        const res = await fetch(`${backendUrl}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 401) onRequireAuth?.();
            throw Object.assign(new Error(body.error || t('admin:venues.requestFailed')), { status: res.status });
        }
        return body;
    }

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setLoadError('');
        request('/admin/venues', { signal: controller.signal })
            .then((body) => { if (!controller.signal.aborted) setData(body); })
            .catch((e) => { if (!controller.signal.aborted) setLoadError(e.message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [backendUrl, token, reload]);

    // 地区树用于给选点器定初始中心，必须在 MapView 挂载前就绪（它只在挂载时读一次 initialCenter）。
    // 失败不影响落点，退回地图默认视野。
    const regionsRef = useRef(null);
    const ensureRegions = async () => {
        if (regionsRef.current) return regionsRef.current;
        try {
            const value = await loadPlaceRegions(backendUrl);
            regionsRef.current = value;
            setRegions(value);
            return value;
        } catch (e) {
            return null;
        }
    };
    useEffect(() => {
        if (data?.pending?.length) ensureRegions();
    }, [backendUrl, data]);

    const refresh = () => setReload((value) => value + 1);

    /** 落点：把管理员选的坐标存进请求本身，不建地点 */
    async function placeAt(item, point) {
        const latitude = Number(point?.lat ?? point?.latitude);
        const longitude = Number(point?.lng ?? point?.longitude);
        setPicking(null);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        setBusyId(item.id);
        try {
            await request(`/admin/venues/${item.id}/place`, { method: 'POST', body: JSON.stringify({ latitude, longitude }) });
            showTip(t('admin:venues.placedTip'));
            refresh();
        } catch (e) {
            showTip(e.message);
        } finally {
            setBusyId(null);
        }
    }

    async function ignore(item) {
        if (busyId) return;
        if (!await confirm(t('admin:venues.confirmIgnore', { label: item.label }), { destructive: true, confirmLabel: t('admin:venues.ignore') })) return;
        setBusyId(item.id);
        try {
            await request(`/admin/venues/${item.id}/ignore`, { method: 'POST', body: JSON.stringify({}) });
            showTip(t('admin:venues.ignoredTip'));
            refresh();
        } catch (e) {
            showTip(e.message);
        } finally {
            setBusyId(null);
        }
    }

    const pending = data?.pending || [];
    const meta = { fontSize: 12, color: 'var(--color-text-secondary)' };
    const card = { border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 10, background: 'var(--color-bg-overlay)' };
    const row = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' };

    return <section aria-labelledby="admin-venues-title">
        <h3 id="admin-venues-title" style={{ marginTop: 0 }}>{t('admin:venues.title')}</h3>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>{t('admin:venues.intro')}</p>

        {loading && <StateMessage kind="loading">{t('admin:venues.loading')}</StateMessage>}
        {!loading && loadError && <StateMessage kind="error" onRetry={refresh} retryLabel={t('admin:venues.retry')}>{loadError}</StateMessage>}
        {!loading && !loadError && pending.length === 0 && <StateMessage>{t('admin:venues.empty')}</StateMessage>}

        {!loading && !loadError && pending.map((item) => <div key={item.id} style={card}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{item.label}</div>
            {item.address && <div style={meta}>{item.address}</div>}
            <div style={meta}>
                {[item.city, t('admin:venues.receivedAt', { time: formatTime(item.created_time) })].filter(Boolean).join(' · ')}
            </div>
            <div style={row}>
                <Button disabled={!!busyId} onClick={async () => { await ensureRegions(); setPicking(item); }}>{t('admin:venues.pick')}</Button>
                <Button variant="secondary" disabled={!!busyId} onClick={() => ignore(item)}>{t('admin:venues.ignore')}</Button>
            </div>
        </div>)}

        <FullScreenMapPicker open={!!picking} title={t('admin:venues.pickLocation')} context="exhibition"
            center={picking ? cityCenterOf(regions, picking.city) : null}
            backendUrl={backendUrl} token={token} isAuthenticated={!!token} onRequireAuth={onRequireAuth}
            onPickPlace={(point) => picking && placeAt(picking, point)}
            onPickPoint={(point) => picking && placeAt(picking, point)}
            onClose={() => setPicking(null)} />
    </section>;
}
