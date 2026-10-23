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
import { getApiBaseUrl, imageThumbnailUrl, resolveResourceUrl } from '../platform/runtimeConfig';
import { peekToken } from '../platform/credentialStore';
import { t, tx } from '../i18n/index.js';

function resolveBackendUrl() {
    return getApiBaseUrl();
}

function getLatestStoredToken() {
    return peekToken();
}

// AI 初筛拦下的新地点（request_type = 'create'）和修改申请在同一个列表里复核，
// 见 backend/modules/places/doc/placeModeration.md
const isCreateRequest = (request) => !!request && request.request_type === 'create';

function storedImages(value) {
    try {
        const list = Array.isArray(value) ? value : JSON.parse(value || '[]');
        return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()) : [];
    } catch (e) {
        return [];
    }
}

export default function AdminPlaces({ backendUrl = null, onOpenPlace = null }) {
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
        const impact = isCreateRequest(target)
            ? (approve ? t('admin:places.createApproveImpact') : t('admin:places.createRejectImpact'))
            : (approve ? t('admin:places.approveImpact') : t('admin:places.rejectImpact'));
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
                { key: 'approve', label: isCreateRequest(request) ? t('admin:places.createApproveAction') : t('admin:places.approveAction'), onClick: () => review(request, 'approve') },
                { key: 'reject', label: isCreateRequest(request) ? t('admin:places.createRejectAction') : t('admin:places.rejectAction'), tone: 'danger', onClick: () => review(request, 'reject') }
            ]}
        />
    );

    const reasonLabels = {
        brief: t('admin:places.moderation.reason.brief'),
        unrelated: t('admin:places.moderation.reason.unrelated'),
        harmful: t('admin:places.moderation.reason.harmful'),
        image: t('admin:places.moderation.reason.image')
    };

    // AI 初筛的拦截原因（新增复核，和被拦下的创建者修改）
    const renderModerationReasons = (request) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('admin:places.moderation.label')}</span>
            {(request.moderation?.decision?.reasons || []).map((reason) => (
                <span key={reason} style={{ padding: '1px 8px', borderRadius: 999, fontSize: 12, border: '1px solid color-mix(in srgb, var(--color-warning) 55%, var(--color-border))', background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)' }}>
                    {reasonLabels[reason] || reason}
                </span>
            ))}
        </div>
    );

    // 新增复核：拦截原因、AI 说明、地点当前内容和图片（被标出的图片加红框），可跳到地图查看
    const renderCreateReview = (request) => {
        const place = request.place;
        if (!place) return <div style={{ color: 'var(--color-text-secondary)' }}>{t('admin:places.placeMissing')}</div>;
        const flagged = new Set(request.moderation?.vision?.flagged_urls || []);
        const images = [
            ...storedImages(place.exterior_images).map((url) => ({ url, label: t('admin:places.moderation.field.exterior') })),
            ...storedImages(place.menu_images).map((url) => ({ url, label: t('admin:places.moderation.field.menu') }))
        ];
        return (
            <div style={{ display: 'grid', gap: 8 }}>
                {renderModerationReasons(request)}
                {request.note && <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{request.note}</div>}
                <JsonTable value={{
                    [t('admin:places.moderation.field.name')]: place.name,
                    [t('admin:places.moderation.field.category')]: place.category || null,
                    [t('admin:places.moderation.field.description')]: place.description || null,
                    [t('admin:places.moderation.field.address')]: place.address || null,
                    [t('admin:places.moderation.field.cost')]: place.per_person_cost ?? null
                }} />
                {images.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {images.map(({ url, label }, index) => (
                            <a key={index + url} href={resolveResourceUrl(url)} target="_blank" rel="noopener noreferrer"
                                title={flagged.has(url) ? label + ' · ' + t('admin:places.moderation.flaggedImage') : label}>
                                <img src={imageThumbnailUrl(url, 160)} alt={label} loading="lazy"
                                    style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, display: 'block', border: flagged.has(url) ? '3px solid var(--color-danger)' : '1px solid var(--color-border)' }} />
                            </a>
                        ))}
                    </div>
                )}
                {onOpenPlace && (
                    <div><Button themeAware onClick={() => onOpenPlace(request.place_id)}>{t('admin:places.openOnMap')}</Button></div>
                )}
            </div>
        );
    };

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
                                                        <div style={{ fontWeight: 700 }}>{isCreateRequest(request) ? tx('admin:places.createTitle', { id: request.id }) : tx('admin:places.requestTitle', { id: request.id })}</div>
                                                        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>
                                                            {isCreateRequest(request)
                                                                ? tx('admin:places.createMeta', { place_id: request.place_id || '-', creator: request.place?.creator_name || request.requester_id || '-' })
                                                                : tx('admin:places.requestMeta', { place_id: request.place_id || '-', requester_id: request.requester_id || '-' })}
                                                        </div>
                                                    </div>
                                                    {renderReviewActions(request)}
                                                </div>
                                                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--color-border)' }}>
                                                    {isCreateRequest(request) ? renderCreateReview(request) : (
                                                        <>
                                                            {request.moderation && <div style={{ marginBottom: 8 }}>{renderModerationReasons(request)}</div>}
                                                            <JsonTable value={request.proposed} />
                                                            {request.note && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{tx('admin:places.requestNote', { note: request.note })}</div>}
                                                        </>
                                                    )}
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
                                                    <td style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.requester_id}>{(isCreateRequest(r) && r.place?.creator_name) || r.requester_id}</td>
                                                    <td style={{ minWidth: 100 }}>{r.created_time}</td>
                                                    <td>{isCreateRequest(r) ? <>{r.status}<div style={{ fontSize: 12, color: 'var(--color-warning)' }}>{t('admin:places.typeCreate')}</div></> : r.status}</td>
                                                    <td style={{ maxWidth: 420, verticalAlign: 'top' }}>
                                                        {isCreateRequest(r) ? renderCreateReview(r) : (
                                                            <>
                                                                {r.moderation && <div style={{ marginBottom: 6 }}>{renderModerationReasons(r)}</div>}
                                                                <JsonTable value={r.proposed} />
                                                                {r.note ? <div style={{ color: 'var(--color-text-secondary)', marginTop: 6 }}>{tx('admin:places.note', { note: r.note })}</div> : null}
                                                            </>
                                                        )}
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
