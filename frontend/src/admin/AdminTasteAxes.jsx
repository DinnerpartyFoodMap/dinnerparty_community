import React, { useEffect, useState } from 'react';
import Button from '../components/primitives/Button';
import TextInput from '../components/forms/TextInput';
import { useTips } from '../components/feedback/Tips';
import { useAuth } from '../auth/AuthContext';
import { TASTE_AXES, axisLabel } from '../profile/tasteAxes';
import { t } from '../i18n/index.js';

const FILTERS = [
    { value: 'unknown', label: t('admin:tasteAxes.filter.unknown') },
    { value: 'llm', label: t('admin:tasteAxes.filter.llm') },
    { value: 'manual', label: t('admin:tasteAxes.filter.manual') }
];
const SOURCE_LABELS = {
    unknown: t('admin:tasteAxes.source.unknown'),
    llm: t('admin:tasteAxes.source.llm'),
    manual: t('admin:tasteAxes.source.manual'),
    rule: t('admin:tasteAxes.source.rule')
};

// 店铺口味分类的人工纠正（后端 /admin/taste-axes，权限 manage_places；说明见 backend modules/preferences/doc/TASTE_AXES.md）：
// 规则判断不了的店由模型补分类或留作“未知”，这里勾选它属于六类里的哪几类；人工结果优先，可以撤销
export default function AdminTasteAxes({ backendUrl }) {
    const { token, onRequireAuth } = useAuth();
    const showTip = useTips();
    const [filter, setFilter] = useState('unknown');
    const [query, setQuery] = useState('');
    const [submittedQuery, setSubmittedQuery] = useState('');
    const [page, setPage] = useState(1);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [drafts, setDrafts] = useState({});
    const [busyId, setBusyId] = useState(null);
    const [reload, setReload] = useState(0);

    async function request(path, options = {}) {
        const res = await fetch(`${backendUrl}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 401) onRequireAuth?.();
            throw new Error(body.error || t('admin:tasteAxes.requestFailed'));
        }
        return body;
    }

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError('');
        const params = new URLSearchParams({ filter, page: String(page) });
        if (submittedQuery) params.set('q', submittedQuery);
        request(`/admin/taste-axes/places?${params}`)
            .then((body) => { if (!cancelled) { setData(body); setDrafts({}); } })
            .catch((error) => { if (!cancelled) setLoadError(error.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter, page, submittedQuery, reload, backendUrl, token]);

    const toggle = (item, axis) => {
        const current = drafts[item.place_id] ?? item.axes;
        const next = current.includes(axis) ? current.filter((value) => value !== axis) : [...current, axis];
        setDrafts((value) => ({ ...value, [item.place_id]: TASTE_AXES.filter((key) => next.includes(key)) }));
    };

    const save = async (item, axes) => {
        setBusyId(item.place_id);
        try {
            await request(`/admin/taste-axes/places/${item.place_id}`, { method: 'PUT', body: JSON.stringify({ axes }) });
            showTip(axes === null ? t('admin:tasteAxes.reset') : t('admin:tasteAxes.saved'));
            setReload((value) => value + 1);
        } catch (error) {
            showTip(error.message);
        } finally {
            setBusyId(null);
        }
    };

    const items = data?.items || [];
    const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
    return (
        <div>
            <h3 style={{ margin: '0 0 6px' }}>{t('admin:tasteAxes.title')}</h3>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--color-text-secondary)' }}>{t('admin:tasteAxes.intro')}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                {FILTERS.map((option) => (
                    <Button key={option.value} themeAware onClick={() => { setFilter(option.value); setPage(1); }}
                        aria-pressed={filter === option.value}
                        style={filter === option.value ? { fontWeight: 700 } : { background: 'transparent', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}>
                        {option.label}
                    </Button>
                ))}
                <form onSubmit={(event) => { event.preventDefault(); setSubmittedQuery(query.trim()); setPage(1); }} style={{ display: 'flex', gap: 6 }}>
                    <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('admin:tasteAxes.searchPlaceholder')} style={{ width: 200 }} />
                    <Button themeAware type="submit">{t('admin:tasteAxes.search')}</Button>
                </form>
            </div>
            {loading && <div role="status">{t('admin:tasteAxes.loading')}</div>}
            {loadError && <div role="alert" style={{ color: 'var(--color-danger)' }}>{loadError}</div>}
            {!loading && !loadError && !items.length && <div style={{ color: 'var(--color-text-secondary)' }}>{t('admin:tasteAxes.empty')}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((item) => {
                    const axes = drafts[item.place_id] ?? item.axes;
                    const changed = drafts[item.place_id] !== undefined;
                    return (
                        <div key={item.place_id} style={{ padding: 10, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                                <strong>{item.name}</strong>
                                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{item.category || t('admin:tasteAxes.noCategory')}</span>
                                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{SOURCE_LABELS[item.source] || item.source}</span>
                            </div>
                            <div role="group" aria-label={t('admin:tasteAxes.axesFor', { name: item.name })} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '8px 0' }}>
                                {TASTE_AXES.map((axis) => (
                                    <label key={axis} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                                        <input type="checkbox" checked={axes.includes(axis)} onChange={() => toggle(item, axis)} />
                                        {axisLabel(axis)}
                                    </label>
                                ))}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <Button themeAware onClick={() => save(item, axes)} disabled={busyId === item.place_id || (!changed && item.source === 'manual')}>
                                    {axes.length ? t('admin:tasteAxes.save') : t('admin:tasteAxes.saveNone')}
                                </Button>
                                {item.source === 'manual' && (
                                    <Button themeAware onClick={() => save(item, null)} disabled={busyId === item.place_id}>{t('admin:tasteAxes.undo')}</Button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {data && data.total > data.page_size && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
                    <Button themeAware onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>{t('admin:tasteAxes.prev')}</Button>
                    <span style={{ fontSize: 13 }}>{t('admin:tasteAxes.page', { page, total: totalPages })}</span>
                    <Button themeAware onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>{t('admin:tasteAxes.next')}</Button>
                </div>
            )}
        </div>
    );
}
