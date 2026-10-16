import React, { useEffect, useState, useRef } from "react";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import { useTips } from "../components/feedback/Tips";
import { useConfirm } from "../components/feedback/Confirm";
import { useAuth } from "../auth/AuthContext";
import JsonTable from "../components/data/JsonTable";
import ResponsiveTable from "../components/data/ResponsiveTable";
import ActionMenu from "../components/overlay/ActionMenu";
import useMediaQuery from "../hooks/useMediaQuery";
import useDarkMode from "../theme/useDarkMode";
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

export default function AdminPlaces({ backendUrl = null }) {
    const base = backendUrl || resolveBackendUrl();
    const { token, user, onRequireAuth } = useAuth();
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(false);
    const showTip = useTips();
    const confirm = useConfirm();
    const [processing, setProcessing] = useState({}); // id -> bool
    const [searchQuery, setSearchQuery] = useState('');
    const [page, setPage] = useState(1);
    const PAGE_SIZE = 10;

    const canManage = user && user.admin_level;
    const fetchIdRef = useRef(0);
    const dark = useDarkMode();
    const themeColor = getThemeColor();
    const isMobile = useMediaQuery('(max-width: 640px)');



    // Fetch when user/token state changes to latest
    useEffect(() => {
        if (!canManage) return;
        fetchRequests();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canManage, token]);

    const handleUnauthorized = () => {
        setRequests([]);
        const authMsg = t('admin:common.error.sessionExpired');
        showTip(authMsg);
        if (onRequireAuth) onRequireAuth();
    };

    // Fetch requests and ignore responses from stale tokens/earlier fetches
    const fetchRequests = async () => {
        setLoading(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token; // capture current token
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/place-requests`, { headers });

            // If token changed since we started, ignore this response
            if (thisFetchId !== fetchIdRef.current) {
                return;
            }

            // If 401 and token changed since request started, retry once with latest token
            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/place-requests`, { headers: retryHeaders });
                    if (thisFetchId !== fetchIdRef.current) {
                        return;
                    }
                }
            }

            if (!res.ok) {
                // Log full response for debugging
                let txt = "";
                try { txt = await res.text(); } catch (e) { txt = "<failed to read body>"; }
                if (res.status === 401) {
                    // show red error message and open auth modal
                    handleUnauthorized();
                    return;
                }
                const preview = typeof txt === 'string' ? (txt.length > 240 ? txt.slice(0, 240) + '...(truncated)' : txt) : String(txt);
                throw new Error(t('admin:places.serverError', { status: res.status, preview }));
            }
            const data = await res.json();
            setRequests(data || []);
        } catch (e) {
            console.error("加载申请失败", e);
            // Already handled 401 via handleUnauthorized; show other errors
            if (e && String(e.message || '').toLowerCase().includes('未登录')) {
                // nothing more
            } else {
                showTip(t('admin:common.error.loadFailedWithMessage', { message: e.message || e }));
            }
        } finally {
            setLoading(false);
        }
    };

    const review = async (target, action) => {
        const id = target.id;
        const approve = action === 'approve';
        const impact = approve ? t('admin:places.approveImpact') : t('admin:places.rejectImpact');
        if (!(await confirm(t('admin:places.confirmReview', { action: approve ? t('admin:places.approve') : t('admin:places.reject'), id, place_id: target.place_id || '-', requester_id: target.requester_id || '-', impact })))) return;
        setProcessing(p => ({ ...p, [id]: true }));
        const thisFetchId = ++fetchIdRef.current; // bump to mark new action
        try {
            const authToken = token;
            const headers = {
                'Content-Type': 'application/json',
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
            };
            let res = await fetch(`${base}/place-requests/${id}/review`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ action })
            });

            if (thisFetchId !== fetchIdRef.current) {
                return;
            }

            // Retry once with latest token if 401 and token changed
            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${latest}`
                    };
                    res = await fetch(`${base}/place-requests/${id}/review`, {
                        method: 'POST',
                        headers: retryHeaders,
                        body: JSON.stringify({ action })
                    });
                    if (thisFetchId !== fetchIdRef.current) {
                        return;
                    }
                }
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                let txt = "";
                try { txt = JSON.stringify(data); } catch (e) { txt = String(data); }
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                throw new Error(data.error || `Review failed ${res.status}`);
            }
            await fetchRequests();
            showTip(t('admin:places.success'));
        } catch (e) {
            console.error('审批失败', e);
            if (e && String(e.message || '').toLowerCase().includes('未登录')) {
                // already handled
            } else {
                showTip(t('admin:places.failed', { message: e.message || e }));
            }
        } finally {
            setProcessing(p => ({ ...p, [id]: false }));
        }
    };

    // 仅显示未处理（pending）的申请
    const pendingRequests = (requests || []).filter(r => r && r.status === 'pending');

    const q = (searchQuery || '').trim().toLowerCase();
    const filtered = q === '' ? pendingRequests : pendingRequests.filter(r => {
        const combined = `${r.id} ${r.place_id} ${r.requester_id} ${r.note || ''} ${JSON.stringify(r.proposed || {})}`.toLowerCase();
        return combined.includes(q);
    });

    const totalPages = Math.max(1, Math.ceil((filtered || []).length / PAGE_SIZE));
    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [totalPages]);

    const pageItems = (filtered || []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const renderReviewActions = (request) => (
        <ActionMenu
            disabled={processing[request.id]}
            items={[
                { key: 'approve', label: t('admin:places.approveAction'), onClick: () => review(request, 'approve') },
                { key: 'reject', label: t('admin:places.rejectAction'), tone: 'danger', onClick: () => review(request, 'reject') }
            ]}
        />
    );

    return (
        <div style={{ marginTop: 12 }}>
            <h3>{t('admin:places.title')}</h3>
            {!canManage && <div style={{ color: 'var(--color-danger)' }}>{t('admin:common.error.noPanelAccess')}</div>}
            {canManage && (
                <div>
                    <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <TextInput
                            value={searchQuery}
                            onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                            placeholder={t('admin:places.searchPlaceholder')}
                            style={{ flex: 1 }}
                        />
                        <Button themeAware onClick={fetchRequests} disabled={loading}>{t('common:action.refresh')}</Button>
                    </div>
                    {loading ? (
                        <div>{t('common:status.loading')}</div>
                    ) : (
                        <div>
                            {filtered.length === 0 ? (
                                <div>{t('admin:places.empty')}</div>
                            ) : isMobile ? (
                                <div>
                                    <div style={{ display: 'grid', gap: 10 }}>
                                        {pageItems.map((request) => (
                                            <article key={request.id} style={{ padding: 12, border: '1px solid var(--color-border)', borderRadius: 12, background: 'var(--color-bg-surface)' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ fontWeight: 700 }}>{tx('admin:places.requestTitle', { id: request.id })}</div>
                                                        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{tx('admin:places.requestMeta', { place_id: request.place_id || '-', requester_id: request.requester_id || '-' })}</div>
                                                    </div>
                                                    {renderReviewActions(request)}
                                                </div>
                                                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--color-border)' }}>
                                                    <JsonTable value={request.proposed} />
                                                    {request.note && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{tx('admin:places.requestNote', { note: request.note })}</div>}
                                                </div>
                                                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>{request.created_time}</div>
                                            </article>
                                        ))}
                                    </div>
                                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <div style={{ fontSize: 13 }}>{tx('admin:places.pageSummary', { count: filtered.length, page, totalPages })}</div>
                                        <div style={{ display: 'flex', gap: 6 }}>
                                            <Button themeAware onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>{t('admin:common.pagination.prev')}</Button>
                                            <Button themeAware onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>{t('admin:common.pagination.next')}</Button>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div>
                                    <ResponsiveTable minWidth={950} cellPadding="8" style={{ border: '1px solid var(--color-border)' }}>
                                        <thead>
                                            <tr>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>ID</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>{t('admin:places.col.placeId')}</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>{t('admin:places.col.requester')}</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 100 }}>{t('admin:places.col.submittedAt')}</th>
                                                <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:places.col.status')}</th>
                                                <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:places.col.proposal')}</th>
                                                <th style={{ textAlign: 'left', padding: 8, minWidth: 140 }}>{t('admin:common.table.actions')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {pageItems.map((r, idx) => (
                                                <tr key={r.id} style={{ background: idx % 2 === 0 ? 'var(--color-bg-overlay)' : undefined }}>
                                                    <td style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.id}>{r.id}</td>
                                                    <td style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.place_id}>{r.place_id}</td>
                                                    <td style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.requester_id}>{r.requester_id}</td>
                                                    <td style={{ minWidth: 100 }}>{r.created_time}</td>
                                                    <td>{r.status}</td>
                                                    <td style={{ maxWidth: 420, verticalAlign: 'top' }}>
                                                        <JsonTable value={r.proposed} />
                                                        {r.note ? <div style={{ color: 'var(--color-text-secondary)', marginTop: 6 }}>{tx('admin:places.note', { note: r.note })}</div> : null}
                                                    </td>
                                                    <td style={{ minWidth: 140 }}>
                                                        {renderReviewActions(r)}
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
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
