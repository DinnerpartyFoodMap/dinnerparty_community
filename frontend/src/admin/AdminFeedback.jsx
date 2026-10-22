import React, { useEffect, useState } from 'react';
import Button from '../components/primitives/Button';
import SelectInput from '../components/forms/SelectInput';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import { useAuth } from '../auth/AuthContext';
import { FEEDBACK_TYPES, feedbackTypeLabel } from '../feedback/feedbackTypes';
import Markdown from '../components/markdown/Markdown';
import { t } from '../i18n/index.js';

const STATUS_TABS = [
    { value: 'open', label: t('admin:feedback.status.open') },
    { value: 'resolved', label: t('admin:feedback.status.resolved') },
    { value: 'all', label: t('admin:feedback.status.all') }
];
const PLATFORM_LABELS = {
    web: t('admin:feedback.platform.web'),
    android: t('admin:feedback.platform.android'),
    ios: t('admin:feedback.platform.ios')
};
const PAGE_SIZE = 20;

// 数据库时间是 UTC 的 “YYYY-MM-DD HH:MM:SS”
function formatTime(value) {
    if (!value) return '';
    const date = new Date(`${String(value).replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** 反馈截图只给管理员看：带凭证读取，转为本地对象地址；点开在新标签页看原图 */
function PrivateFeedbackImage({ backendUrl, token, image, index }) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        let objectUrl;
        fetch(`${backendUrl}/admin/feedback/images/${encodeURIComponent(image.id)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
            .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.blob(); })
            .then((blob) => { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); })
            .catch(() => {});
        return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [backendUrl, token, image.id]);
    const box = { width: 96, height: 96, borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-bg-overlay)', display: 'block' };
    if (!url) return <span role="img" aria-label={t('admin:feedback.imageLoading')} style={box} />;
    return (
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label={t('admin:feedback.openImage', { index: index + 1 })}>
            <img src={url} alt={t('admin:feedback.imageAlt', { index: index + 1 })} style={{ ...box, objectFit: 'cover' }} />
        </a>
    );
}

// 住民反馈：按状态 / 类型筛选，查看截图，标记已处理或删除（后端 /admin/feedback，权限 manage_feedback）
export default function AdminFeedback({ backendUrl }) {
    const { token, onRequireAuth } = useAuth();
    const showTip = useTips();
    const confirm = useConfirm();
    const [status, setStatus] = useState('open');
    const [type, setType] = useState('');
    const [page, setPage] = useState(1);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [reload, setReload] = useState(0);
    const [busyId, setBusyId] = useState(null);

    async function request(path, options = {}) {
        const res = await fetch(`${backendUrl}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 401) onRequireAuth?.();
            throw new Error(body.error || t('admin:feedback.requestFailed'));
        }
        return body;
    }

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setLoadError('');
        const query = new URLSearchParams({ status, page: String(page), pageSize: String(PAGE_SIZE) });
        if (type) query.set('type', type);
        request(`/admin/feedback?${query}`, { signal: controller.signal }).then((body) => {
            if (!controller.signal.aborted) setData(body);
        }).catch((e) => {
            if (!controller.signal.aborted) setLoadError(e.message);
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [backendUrl, token, status, type, page, reload]);

    const changeFilter = (setter) => (value) => { setter(value); setPage(1); };

    async function toggleStatus(item) {
        if (busyId) return;
        const next = item.status === 'resolved' ? 'open' : 'resolved';
        setBusyId(item.id);
        try {
            await request(`/admin/feedback/${item.id}/status`, { method: 'PUT', body: JSON.stringify({ status: next }) });
            showTip(next === 'resolved' ? t('admin:feedback.resolvedTip') : t('admin:feedback.reopenedTip'));
            setReload((value) => value + 1);
        } catch (e) {
            showTip(e.message);
        } finally {
            setBusyId(null);
        }
    }

    async function remove(item) {
        if (busyId || !await confirm(t('admin:feedback.confirmDelete'))) return;
        setBusyId(item.id);
        try {
            await request(`/admin/feedback/${item.id}`, { method: 'DELETE' });
            showTip(t('admin:feedback.deletedTip'));
            setReload((value) => value + 1);
        } catch (e) {
            showTip(e.message);
        } finally {
            setBusyId(null);
        }
    }

    const items = data?.items || [];
    const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
    const tabCount = (value) => (data?.counts ? (value === 'all' ? Object.values(data.counts).reduce((sum, n) => sum + n, 0) : data.counts[value] || 0) : null);
    const meta = { fontSize: 12, color: 'var(--color-text-secondary)' };

    return <section aria-labelledby="admin-feedback-title">
        <h3 id="admin-feedback-title" style={{ marginTop: 0 }}>{t('admin:feedback.title')}</h3>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>{t('admin:feedback.intro')}</p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <div role="tablist" aria-label={t('admin:feedback.statusFilter')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {STATUS_TABS.map((tab) => {
                    const count = tabCount(tab.value);
                    const selected = status === tab.value;
                    return (
                        <Button key={tab.value} themeAware role="tab" aria-selected={selected} onClick={() => changeFilter(setStatus)(tab.value)}
                            style={selected ? undefined : { background: 'var(--color-bg-overlay)' }}>
                            {count == null ? tab.label : t('admin:feedback.tabWithCount', { label: tab.label, count })}
                        </Button>
                    );
                })}
            </div>
            <SelectInput value={type} onChange={(event) => changeFilter(setType)(event.target.value)} aria-label={t('admin:feedback.typeFilter')} style={{ minWidth: 150 }}>
                <option value="">{t('admin:feedback.allTypes')}</option>
                {FEEDBACK_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </SelectInput>
        </div>

        {loading && !data ? (
            <p role="status" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('admin:feedback.loading')}</p>
        ) : loadError ? (
            <div>
                <div role="alert" style={{ color: 'var(--color-danger)' }}>{t('admin:feedback.loadFailed', { message: loadError })}</div>
                <Button themeAware onClick={() => setReload((value) => value + 1)} style={{ marginTop: 8 }}>{t('admin:feedback.retry')}</Button>
            </div>
        ) : items.length === 0 ? (
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('admin:feedback.empty')}</p>
        ) : (
            <div style={{ display: 'grid', gap: 10, opacity: loading ? 0.6 : 1 }}>
                {items.map((item) => (
                    <article key={item.id} style={{ padding: 12, borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-bg-overlay)' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px' }}>
                            <strong>{feedbackTypeLabel(item.type)}</strong>
                            <span style={{ fontSize: 12, fontWeight: 700, color: item.status === 'resolved' ? 'var(--color-success)' : 'var(--theme-primary)' }}>
                                {item.status === 'resolved' ? t('admin:feedback.status.resolved') : t('admin:feedback.status.open')}
                            </span>
                            <span style={meta}>#{item.id} · {formatTime(item.created_time)}</span>
                        </div>
                        <div style={{ ...meta, marginTop: 4 }}>
                            {t('admin:feedback.from', { username: item.username || t('admin:feedback.unknownUser'), qq: item.qq || '-' })}
                            {' · '}{PLATFORM_LABELS[item.platform] || item.platform}{item.app_version ? ` v${item.app_version}` : ''}
                        </div>
                        <Markdown text={item.content} style={{ marginTop: 8 }} />
                        {item.images.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                                {item.images.map((image, index) => <PrivateFeedbackImage key={image.id} backendUrl={backendUrl} token={token} image={image} index={index} />)}
                            </div>
                        )}
                        {item.user_agent && <div style={{ ...meta, marginTop: 8, fontSize: 11, wordBreak: 'break-all' }}>{item.user_agent}</div>}
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10 }}>
                            <span style={meta}>
                                {item.status === 'resolved' && t('admin:feedback.handledBy', { name: item.handler_username || '-', time: formatTime(item.handled_time) })}
                            </span>
                            <span style={{ display: 'flex', gap: 6 }}>
                                <Button themeAware onClick={() => toggleStatus(item)} disabled={!!busyId} style={{ fontSize: 12, padding: '4px 8px' }}>
                                    {item.status === 'resolved' ? t('admin:feedback.reopen') : t('admin:feedback.resolve')}
                                </Button>
                                <Button themeAware onClick={() => remove(item)} disabled={!!busyId}
                                    style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', fontSize: 12, padding: '4px 8px' }}>
                                    {t('admin:feedback.delete')}
                                </Button>
                            </span>
                        </div>
                    </article>
                ))}
            </div>
        )}

        {data && data.total > data.pageSize && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 12 }}>
                <Button themeAware onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={loading || page <= 1}>{t('admin:feedback.prevPage')}</Button>
                <span style={meta}>{t('admin:feedback.pageInfo', { page, total: totalPages })}</span>
                <Button themeAware onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={loading || page >= totalPages}>{t('admin:feedback.nextPage')}</Button>
            </div>
        )}
    </section>;
}
