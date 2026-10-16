import React, { useEffect, useState, useRef } from "react";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import { useTips } from "../components/feedback/Tips";
import { useConfirm } from "../components/feedback/Confirm";
import { useAuth } from "../auth/AuthContext";
import useDarkMode from "../theme/useDarkMode";
import ResponsiveTable from "../components/data/ResponsiveTable";
import { getApiBaseUrl } from '../platform/runtimeConfig';
import { peekToken } from '../platform/credentialStore';
import { t, tx } from '../i18n/index.js';

function resolveBackendUrl() {
    return getApiBaseUrl();
}

function getLatestStoredToken() {
    return peekToken();
}

export default function AdminQQWhitelist({ backendUrl = null }) {
    const base = backendUrl || resolveBackendUrl();
    const { token, user, onRequireAuth } = useAuth();
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(false);
    const showTip = useTips();
    const confirm = useConfirm();
    const [qqInput, setQqInput] = useState("");
    const [batchInput, setBatchInput] = useState("");
    const [adding, setAdding] = useState(false);
    const [processing, setProcessing] = useState({});
    const [searchQuery, setSearchQuery] = useState("");
    const [page, setPage] = useState(1);
    const fetchIdRef = useRef(0);
    const dark = useDarkMode();

    const canManage = user && user.admin_level;

    useEffect(() => {
        if (!canManage) return;
        fetchEntries();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canManage, token]);

    const handleUnauthorized = () => {
        setEntries([]);
        showTip(t('admin:common.error.sessionExpired'));
        if (onRequireAuth) onRequireAuth();
    };

    const fetchEntries = async () => {
        setLoading(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/qq-whitelist`, { headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/qq-whitelist`, { headers: retryHeaders });
                    if (thisFetchId !== fetchIdRef.current) return;
                }
            }

            if (!res.ok) {
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                if (res.status === 403) {
                    showTip(t('admin:qqWhitelist.forbidden'));
                    return;
                }
                throw new Error(t('admin:qqWhitelist.serverError', { status: res.status }));
            }

            const data = await res.json().catch(() => []);
            setEntries(data || []);
        } catch (e) {
            console.error('加载QQ白名单失败', e);
            showTip(t('admin:common.error.loadFailedWithMessage', { message: e.message || e }));
        } finally {
            setLoading(false);
        }
    };

    const addQQ = async (e) => {
        e && e.preventDefault();
        // 优先使用批量输入，否则使用单个输入
        const raw = (batchInput || qqInput).trim();
        if (!raw) return showTip(t('admin:qqWhitelist.enterQQ'));

        setAdding(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
            };
            let res = await fetch(`${base}/admin/qq-whitelist`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ qq: raw })
            });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${latest}`
                    };
                    res = await fetch(`${base}/admin/qq-whitelist`, {
                        method: 'POST',
                        headers: retryHeaders,
                        body: JSON.stringify({ qq: raw })
                    });
                    if (thisFetchId !== fetchIdRef.current) return;
                }
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                throw new Error(data.error || t('admin:qqWhitelist.addFailedStatus', { status: res.status }));
            }

            const { added = [], skipped = [] } = data;
            const parts = [];
            if (added.length > 0) parts.push(t('admin:qqWhitelist.addedSummary', { count: added.length, added: added.join(t('common:punctuation.listSeparator')) }));
            if (skipped.length > 0) parts.push(t('admin:qqWhitelist.skippedSummary', { count: skipped.length, details: skipped.map(s => `${s.qq}(${s.reason})`).join(t('common:punctuation.listSeparator')) }));
            showTip(parts.join(t('admin:qqWhitelist.summarySeparator')) || t('admin:qqWhitelist.done'));
            setQqInput("");
            setBatchInput("");
            await fetchEntries();
        } catch (e) {
            console.error('addQQ failed', e);
            showTip(t('admin:qqWhitelist.addFailed', { message: e.message || e }));
        } finally {
            setAdding(false);
        }
    };

    const deleteEntry = async (id) => {
        if (!(await confirm(t('admin:qqWhitelist.confirmRemove')))) return;
        setProcessing(p => ({ ...p, [id]: true }));
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/qq-whitelist/${id}`, { method: 'DELETE', headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/qq-whitelist/${id}`, { method: 'DELETE', headers: retryHeaders });
                    if (thisFetchId !== fetchIdRef.current) return;
                }
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                throw new Error(data.error || t('common:error.deleteFailedStatus', { status: res.status }));
            }

            showTip(t('admin:qqWhitelist.removed'));
            setEntries(list => list.filter(e => e.id !== id));
        } catch (e) {
            console.error('deleteEntry failed', e);
            showTip(t('common:error.deleteFailedWithMessage', { message: e.message || e }));
        } finally {
            setProcessing(p => ({ ...p, [id]: false }));
        }
    };

    if (!canManage) return <div style={{ color: 'var(--color-danger)' }}>{t('admin:common.error.noPanelAccess')}</div>;

    const PAGE_SIZE = 30;

    const filteredEntries = entries.filter(entry => {
        if (!searchQuery) return true;
        return String(entry.qq || '').toLowerCase().includes(searchQuery.toLowerCase());
    });

    const totalPages = Math.max(1, Math.ceil((filteredEntries || []).length / PAGE_SIZE));
    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [totalPages, page]);

    const pageEntries = (filteredEntries || []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    return (
        <div style={{ marginTop: 12 }}>
            <h3>{t('admin:qqWhitelist.title')}</h3>
            <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <TextInput
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                    placeholder={t('admin:qqWhitelist.searchPlaceholder')}
                    style={{ flex: 1 }}
                />
                <Button themeAware onClick={fetchEntries} disabled={loading}>{t('common:action.refresh')}</Button>
            </div>

            <div style={{ marginBottom: 12, padding: 8, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg-overlay)' }}>
                <div style={{ marginBottom: 8 }}><strong>{t('admin:qqWhitelist.addTitle')}</strong></div>
                <div style={{ marginBottom: 8 }}>
                    <label style={{ marginRight: 8, color: 'var(--color-text-secondary)' }}>{t('admin:qqWhitelist.singleLabel')}</label>
                    <TextInput
                        placeholder={t('admin:qqWhitelist.qqPlaceholder')}
                        value={qqInput}
                        onChange={e => { setQqInput(e.target.value); setBatchInput(""); }}
                        style={{ width: 220, marginRight: 8 }}
                    />
                </div>
                <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', marginBottom: 4, color: 'var(--color-text-secondary)' }}>{t('admin:qqWhitelist.batchLabel')}</label>
                    <textarea
                        placeholder={"123456789\n987654321"}
                        value={batchInput}
                        onChange={e => { setBatchInput(e.target.value); setQqInput(""); }}
                        rows={4}
                        style={{
                            width: '100%',
                            maxWidth: 400,
                            boxSizing: 'border-box',
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid var(--color-border)',
                            background: 'var(--color-bg-overlay)',
                            color: 'var(--color-text-primary)',
                            resize: 'vertical',
                            fontSize: 14
                        }}
                    />
                </div>
                <Button themeAware onClick={addQQ} disabled={adding || (!qqInput.trim() && !batchInput.trim())}>
                    {adding ? t('admin:qqWhitelist.adding') : t('admin:qqWhitelist.add')}
                </Button>
            </div>

            {loading ? (
                <div>{t('common:status.loading')}</div>
            ) : (
                <div>
                    {filteredEntries.length === 0 ? (
                        <div>{t('admin:qqWhitelist.empty')}</div>
                    ) : (
                        <ResponsiveTable minWidth={600} cellPadding="8" style={{ border: '1px solid var(--color-border)' }}>
                            <thead>
                                <tr>
                                    <th style={{ textAlign: 'left', padding: 8, minWidth: 60 }}>ID</th>
                                    <th style={{ textAlign: 'left', padding: 8, minWidth: 150 }}>{t('common:label.qq')}</th>
                                    <th style={{ textAlign: 'left', padding: 8, minWidth: 120 }}>{t('admin:qqWhitelist.col.addedAt')}</th>
                                    <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>{t('admin:common.table.actions')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pageEntries.map((entry, idx) => (
                                    <tr key={entry.id} style={{ background: idx % 2 === 0 ? 'var(--color-bg-overlay)' : undefined }}>
                                        <td>{entry.id}</td>
                                        <td>{entry.qq}</td>
                                        <td>{entry.created_time || "-"}</td>
                                        <td>
                                            <Button
                                                themeAware
                                                onClick={() => deleteEntry(entry.id)}
                                                disabled={processing[entry.id]}
                                                style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', fontSize: 12, padding: '4px 6px' }}
                                            >
                                                {t('common:action.delete')}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </ResponsiveTable>
                    )}
                </div>
            )}

            {!loading && filteredEntries.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>{tx('admin:common.pagination.summary', { count: filteredEntries.length, page, totalPages })}</div>
                    <div>
                        <Button themeAware onClick={() => setPage(1)} disabled={page === 1} style={{ marginRight: 6 }}>{t('admin:common.pagination.first')}</Button>
                        <Button themeAware onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={{ marginRight: 6 }}>{t('admin:common.pagination.prev')}</Button>
                        <Button themeAware onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{ marginRight: 6 }}>{t('admin:common.pagination.next')}</Button>
                        <Button themeAware onClick={() => setPage(totalPages)} disabled={page === totalPages}>{t('admin:common.pagination.last')}</Button>
                    </div>
                </div>
            )}
        </div>
    );
}
