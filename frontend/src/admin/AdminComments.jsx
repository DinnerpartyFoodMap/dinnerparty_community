import React, { useEffect, useState, useRef } from "react";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import { useTips } from "../components/feedback/Tips";
import { useConfirm } from "../components/feedback/Confirm";
import { useAuth } from "../auth/AuthContext";
import useDarkMode from "../theme/useDarkMode";
import ResponsiveTable from "../components/data/ResponsiveTable";
import { getThemeColor } from "../theme/theme";
import { getApiBaseUrl } from '../platform/runtimeConfig';
import { peekToken } from '../platform/credentialStore';
import { t, tx } from '../i18n/index.js';

function resolveBackendUrl() {
    return getApiBaseUrl();
}

function getLatestStoredToken() {
    return peekToken();
}

export default function AdminComments({ backendUrl = null }) {
    const base = backendUrl || resolveBackendUrl();
    const { token, user, onRequireAuth } = useAuth();
    const [comments, setComments] = useState([]);
    const [loading, setLoading] = useState(false);
    const showTip = useTips();
    const confirm = useConfirm();
    const [processing, setProcessing] = useState({});
    const dark = useDarkMode();
    const themeColor = getThemeColor();
    const hexToRgba = (hex, a = 1) => {
        try {
            let h = (hex || '').replace('#', '');
            if (h.length === 3) h = h.split('').map(c => c + c).join('');
            const bigint = parseInt(h, 16);
            const r = (bigint >> 16) & 255;
            const g = (bigint >> 8) & 255;
            const b = bigint & 255;
            return `rgba(${r},${g},${b},${a})`;
        } catch (e) {
            return `rgba(0,0,0,${a})`;
        }
    };
    const [searchQuery, setSearchQuery] = useState('');
    const [page, setPage] = useState(1);
    const PAGE_SIZE = 10;
    const fetchIdRef = useRef(0);

    const canManage = user && user.admin_level;

    useEffect(() => {
        if (!canManage) return;
        fetchComments();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canManage, token]);

    const handleUnauthorized = () => {
        setComments([]);
        const authMsg = t('admin:common.error.sessionExpired');
        showTip(authMsg);
        if (onRequireAuth) onRequireAuth();
    };

    const fetchComments = async () => {
        setLoading(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/comments`, { headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/comments`, { headers: retryHeaders });
                    if (thisFetchId !== fetchIdRef.current) return;
                }
            }

            if (!res.ok) {
                const txt = await res.text().catch(() => "");
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                if (res.status === 403) {
                    showTip(t('admin:comments.forbidden'));
                    return;
                }
                throw new Error(t('admin:common.error.serverStatusDetail', { status: res.status, txt }));
            }

            const data = await res.json().catch(() => []);
            setComments(data || []);
        } catch (e) {
            console.error('加载评论失败', e);
            if (e && String(e.message || '').toLowerCase().includes('未登录')) {
                // handled
            } else {
                showTip(t('admin:common.error.loadFailedWithMessage', { message: e.message || e }));
            }
        } finally {
            setLoading(false);
        }
    };

    const deleteComment = async (id) => {
        if (!(await confirm(t('admin:comments.confirmDelete')))) return;
        setProcessing(p => ({ ...p, [id]: true }));
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/comments/${id}`, { method: 'DELETE', headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/comments/${id}`, { method: 'DELETE', headers: retryHeaders });
                    if (thisFetchId !== fetchIdRef.current) return;
                }
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                showTip(data.error || t('common:error.deleteFailedStatus', { status: res.status }));
                return;
            }

            showTip(t('common:status.deleted'));
            setComments(list => list.filter(c => c.id !== id));
        } catch (e) {
            console.error('deleteComment failed', e);
            showTip(t('common:error.deleteFailedWithMessage', { message: e.message || e }));
        } finally {
            setProcessing(p => ({ ...p, [id]: false }));
        }
    };

    if (!canManage) return <div style={{ color: 'var(--color-danger)' }}>{t('admin:common.error.noPanelAccess')}</div>;

    return (
        <div style={{ marginTop: 12 }}>
            <h3>{t('admin:comments.title')}</h3>
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <TextInput
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                    placeholder={t('admin:comments.searchPlaceholder')}
                    style={{ flex: 1 }}
                />
                <Button themeAware onClick={fetchComments} disabled={loading}>{t('common:action.refresh')}</Button>
            </div>

            {loading ? (
                <div>{t('common:status.loading')}</div>
            ) : (
                <div>
                    {comments.length === 0 ? (
                        <div>{t('admin:comments.empty')}</div>
                    ) : (
                        (() => {
                            const q = (searchQuery || '').trim().toLowerCase();
                            const filtered = q === '' ? comments : comments.filter(c => {
                                const combined = `${c.id} ${c.place_id || c.placeId || ''} ${c.user_id || c.userId || ''} ${c.content || c.text || ''}`.toLowerCase();
                                return combined.includes(q);
                            });
                            const totalPages = Math.max(1, Math.ceil((filtered || []).length / PAGE_SIZE));
                            if (page > totalPages) setPage(totalPages);
                            const pageItems = (filtered || []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

                            if (filtered.length === 0) return <div>{t('admin:comments.noMatch')}</div>;

                            return (
                                <div>
                                    <ResponsiveTable minWidth={850} cellPadding="8" style={{ border: '1px solid var(--color-border)' }}>
                                        <thead>
                                            <tr>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>ID</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>{t('admin:comments.col.placeId')}</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>{t('admin:comments.col.userId')}</th>
                                                <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:comments.col.content')}</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 100 }}>{t('admin:comments.col.createdAt')}</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 100 }}>{t('admin:common.table.actions')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {pageItems.map((c, idx) => (
                                                <tr key={c.id} style={{ background: idx % 2 === 0 ? 'var(--color-bg-overlay)' : undefined }}>
                                                    <td style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.id}>{c.id}</td>
                                                    <td style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.place_id || c.placeId}>{c.place_id || c.placeId || '-'}</td>
                                                    <td style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.user_id || c.userId}>{c.user_id || c.userId || '-'}</td>
                                                    <td style={{ maxWidth: 420 }}>
                                                        <div style={{ whiteSpace: 'pre-wrap' }}>{c.content || c.text || ''}</div>
                                                    </td>
                                                    <td>{c.created_time || c.createdTime || '-'}</td>
                                                    <td style={{ minWidth: 100 }}>
                                                        <Button themeAware onClick={() => deleteComment(c.id)} disabled={processing[c.id]} style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', fontSize: 12, padding: '4px 6px' }}>{t('common:action.delete')}</Button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </ResponsiveTable>

                                    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>{tx('admin:common.pagination.summary', { count: filtered.length, page, totalPages })}</div>
                                        <div>
                                            <Button themeAware onClick={() => setPage(1)} disabled={page === 1} style={{ marginRight: 6 }}>{t('admin:common.pagination.first')}</Button>
                                            <Button themeAware onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={{ marginRight: 6 }}>{t('admin:common.pagination.prev')}</Button>
                                            <Button themeAware onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{ marginRight: 6 }}>{t('admin:common.pagination.next')}</Button>
                                            <Button themeAware onClick={() => setPage(totalPages)} disabled={page === totalPages}>{t('admin:common.pagination.last')}</Button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })()
                    )}
                </div>
            )}
        </div>
    );
}
