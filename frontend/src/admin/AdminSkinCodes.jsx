import React, { useEffect, useState } from 'react';
import Button from '../components/primitives/Button';
import TextInput from '../components/forms/TextInput';
import SelectInput from '../components/forms/SelectInput';
import ResponsiveTable from '../components/data/ResponsiveTable';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import { useAuth } from '../auth/AuthContext';
import { getSkin } from '../skins/registry';
import { copyText } from '../platform/share';
import { t } from '../i18n/index.js';

const EMPTY_FORM = { skin_id: '', count: '10', max_uses: '1', expires_days: '', note: '' };
const STATUS_LABELS = {
    active: t('admin:skinCodes.status.active'),
    exhausted: t('admin:skinCodes.status.exhausted'),
    expired: t('admin:skinCodes.status.expired'),
    revoked: t('admin:skinCodes.status.revoked')
};

// 皮肤兑换码：沿用旧邀请码表，独立使用 manage_skin_codes 权限（后端 /admin/skin-codes）
export default function AdminSkinCodes({ backendUrl }) {
    const { token, onRequireAuth } = useAuth();
    const showTip = useTips();
    const confirm = useConfirm();
    const [catalog, setCatalog] = useState([]);
    const [codes, setCodes] = useState([]);
    const [form, setForm] = useState(EMPTY_FORM);
    const [created, setCreated] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [reload, setReload] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function request(path, options = {}) {
        const res = await fetch(`${backendUrl}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 401) onRequireAuth?.();
            throw new Error(data.error || t('admin:skinCodes.requestFailed'));
        }
        return data;
    }

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setLoadError('');
        request('/admin/skin-codes', { signal: controller.signal }).then((data) => {
            if (controller.signal.aborted) return;
            setCatalog(data.catalog || []);
            setCodes(data.codes || []);
            setForm((prev) => (prev.skin_id || !data.catalog?.length ? prev : { ...prev, skin_id: data.catalog[0].id }));
        }).catch((e) => {
            if (!controller.signal.aborted) setLoadError(e.message);
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [backendUrl, token, reload]);

    const change = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
    const skinLabel = (skin) => (getSkin(skin.id) ? skin.name : t('admin:skinCodes.notInBuild', { name: skin.name }));

    async function generate(event) {
        event.preventDefault();
        if (busy || !form.skin_id) return;
        setBusy(true);
        setError('');
        try {
            const data = await request('/admin/skin-codes', {
                method: 'POST',
                body: JSON.stringify({
                    skin_id: form.skin_id,
                    count: Number(form.count),
                    max_uses: Number(form.max_uses),
                    expires_days: form.expires_days.trim() ? Number(form.expires_days) : null,
                    note: form.note.trim()
                })
            });
            const fresh = data.codes || [];
            setCreated(fresh);
            setCodes((prev) => [...fresh, ...prev.filter((item) => !fresh.some((code) => code.id === item.id))]);
            showTip(t('admin:skinCodes.generated', { count: fresh.length }));
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    async function copyCreated() {
        const ok = await copyText(created.map((item) => item.code).join('\n'));
        showTip(ok ? t('admin:skinCodes.copied') : t('admin:skinCodes.copyFailed'));
    }

    async function revoke(item) {
        if (busy || !await confirm(t('admin:skinCodes.confirmRevoke', { code: item.code }))) return;
        setBusy(true);
        try {
            const data = await request(`/admin/skin-codes/${item.id}`, { method: 'DELETE' });
            setCodes((prev) => prev.map((code) => (code.id === item.id ? data.code : code)));
            setCreated((prev) => prev.map((code) => (code.id === item.id ? data.code : code)));
            showTip(t('admin:skinCodes.revokedTip', { code: item.code }));
        } catch (e) {
            showTip(e.message);
        } finally {
            setBusy(false);
        }
    }

    const disabled = loading || busy || !!loadError || !catalog.length;
    const cell = { textAlign: 'left', padding: 8 };

    return <section aria-labelledby="skin-codes-title">
        <h3 id="skin-codes-title" style={{ marginTop: 0 }}>{t('admin:skinCodes.title')}</h3>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>{t('admin:skinCodes.intro')}</p>
        {loading ? (
            <p role="status" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('admin:skinCodes.loading')}</p>
        ) : loadError ? (
            <div>
                <div role="alert" style={{ color: 'var(--color-danger)' }}>{t('admin:skinCodes.loadFailed', { message: loadError })}</div>
                <Button themeAware onClick={() => setReload((value) => value + 1)} style={{ marginTop: 8 }}>{t('admin:skinCodes.retry')}</Button>
            </div>
        ) : !catalog.length ? (
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('admin:skinCodes.emptyCatalog')}</p>
        ) : (
            <form onSubmit={generate} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
                <label style={{ display: 'grid', gap: 6 }}>
                    <span>{t('admin:skinCodes.skin')}</span>
                    <SelectInput value={form.skin_id} onChange={change('skin_id')} disabled={disabled} style={{ width: '100%' }}>
                        {catalog.map((skin) => <option key={skin.id} value={skin.id}>{skinLabel(skin)}</option>)}
                    </SelectInput>
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                    <span>{t('admin:skinCodes.count')}</span>
                    <TextInput type="number" min={1} max={200} value={form.count} onChange={change('count')} disabled={disabled} style={{ width: '100%' }} />
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                    <span>{t('admin:skinCodes.maxUses')}</span>
                    <TextInput type="number" min={1} max={10000} value={form.max_uses} onChange={change('max_uses')} disabled={disabled} style={{ width: '100%' }} />
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                    <span>{t('admin:skinCodes.expiresDays')}</span>
                    <TextInput type="number" min={1} max={3650} value={form.expires_days} onChange={change('expires_days')} disabled={disabled}
                        placeholder={t('admin:skinCodes.expiresHint')} style={{ width: '100%' }} />
                </label>
                <label style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
                    <span>{t('admin:skinCodes.note')}</span>
                    <TextInput value={form.note} onChange={change('note')} maxLength={100} disabled={disabled}
                        placeholder={t('admin:skinCodes.notePlaceholder')} style={{ width: '100%' }} />
                </label>
                {error && <div role="alert" style={{ color: 'var(--color-danger)', gridColumn: '1 / -1' }}>{error}</div>}
                <div style={{ gridColumn: '1 / -1' }}>
                    <Button type="submit" themeAware disabled={disabled}>{busy ? t('admin:skinCodes.generating') : t('admin:skinCodes.generate')}</Button>
                </div>
            </form>
        )}

        {created.length > 0 && (
            <div style={{ marginTop: 16, padding: 12, borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-bg-overlay)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{t('admin:skinCodes.newCodes')}</strong>
                    <Button themeAware onClick={copyCreated}>{t('admin:skinCodes.copyAll')}</Button>
                </div>
                <pre style={{ margin: '10px 0 0', whiteSpace: 'pre-wrap', fontSize: 14, userSelect: 'all' }}>{created.map((item) => item.code).join('\n')}</pre>
            </div>
        )}

        {!loading && !loadError && (
            <div style={{ marginTop: 18 }}>
                <h4 style={{ margin: '0 0 8px' }}>{t('admin:skinCodes.listTitle')}</h4>
                {codes.length === 0 ? (
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('admin:skinCodes.empty')}</div>
                ) : (
                    <ResponsiveTable minWidth={720} cellPadding="8" style={{ border: '1px solid var(--color-border)' }}>
                        <thead>
                            <tr>
                                <th style={cell}>{t('admin:skinCodes.column.code')}</th>
                                <th style={cell}>{t('admin:skinCodes.column.skin')}</th>
                                <th style={cell}>{t('admin:skinCodes.column.uses')}</th>
                                <th style={cell}>{t('admin:skinCodes.column.expires')}</th>
                                <th style={cell}>{t('admin:skinCodes.column.status')}</th>
                                <th style={cell}>{t('admin:skinCodes.column.note')}</th>
                                <th style={cell}>{t('admin:common.table.actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {codes.map((item, index) => (
                                <tr key={item.id} style={{ background: index % 2 === 0 ? 'var(--color-bg-overlay)' : undefined }}>
                                    <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'nowrap' }}>{item.code}</td>
                                    <td>{item.skin_name}</td>
                                    <td>{t('admin:skinCodes.usage', { used: item.current_uses, max: item.max_uses })}</td>
                                    <td>{item.expires_time ? new Date(item.expires_time).toLocaleString() : t('admin:skinCodes.never')}</td>
                                    <td style={{ color: item.status === 'active' ? 'var(--color-success)' : 'var(--color-text-secondary)' }}>{STATUS_LABELS[item.status] || item.status}</td>
                                    <td>{item.note || '-'}</td>
                                    <td>
                                        {item.status !== 'revoked' && (
                                            <Button themeAware onClick={() => revoke(item)} disabled={busy}
                                                style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', fontSize: 12, padding: '4px 6px' }}>
                                                {t('admin:skinCodes.revoke')}
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </ResponsiveTable>
                )}
            </div>
        )}
    </section>;
}
