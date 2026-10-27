import React, { useEffect, useState, useRef } from "react";
import Button from "../components/primitives/Button";
import { useAuth } from "../auth/AuthContext";
import AdminBanModal from "./AdminBanModal";
import AdminQqModal from "./AdminQqModal";
import ResponsiveTable from "../components/data/ResponsiveTable";
import TextInput from "../components/forms/TextInput";
import ActionMenu from "../components/overlay/ActionMenu";
import useMediaQuery from "../hooks/useMediaQuery";
import { useTips } from "../components/feedback/Tips";
import { useConfirm } from "../components/feedback/Confirm";
import defaultAvatar from '../img/default.png';
import { getApiBaseUrl } from '../platform/runtimeConfig';
import { peekToken } from '../platform/credentialStore';
import { t, tx } from '../i18n/index.js';

function resolveBackendUrl() {
    return getApiBaseUrl();
}

function getLatestStoredToken() {
    return peekToken();
}

export default function AdminUsers({ backendUrl = null }) {
    const base = backendUrl || resolveBackendUrl();
    const { token, user, onRequireAuth } = useAuth();
    const [users, setUsers] = useState([]);
    const showTip = useTips();
    const confirm = useConfirm();
    const [loading, setLoading] = useState(false);
    const [processing, setProcessing] = useState({});
    const [banModalOpen, setBanModalOpen] = useState(false);
    const [banTarget, setBanTarget] = useState(null);
    const [qqTarget, setQqTarget] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [page, setPage] = useState(1);
    const fetchIdRef = useRef(0);
    const isMobile = useMediaQuery('(max-width: 640px)');

    const canManage = user && user.admin_level;

    useEffect(() => {
        if (!canManage) return;
        fetchUsers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canManage, token]);

    const handleUnauthorized = () => {
        setUsers([]);
        const authMsg = t('admin:common.error.sessionExpired');
        showTip(authMsg);
        if (onRequireAuth) onRequireAuth();
    };

    const fetchUsers = async () => {
        setLoading(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/users`, { headers });

            if (thisFetchId !== fetchIdRef.current) return; // stale

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/users`, { headers: retryHeaders });
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
                    showTip(t('admin:users.forbidden'));
                    return;
                }
                throw new Error(t('admin:common.error.serverStatusDetail', { status: res.status, txt }));
            }

            const data = await res.json().catch(() => []);
            setUsers(data || []);
        } catch (e) {
            console.error('加载用户失败', e);
            if (e && String(e.message || '').toLowerCase().includes('未登录')) {
                // handled
            } else {
                showTip(t('admin:common.error.loadFailedWithMessage', { message: e.message || e }));
            }
        } finally {
            setLoading(false);
        }
    };

    const changeLevel = async (userId, newLevel) => {
        const target = users.find(item => item.id === userId);
        const oldLabel = target?.admin_level || t('admin:users.regularUser');
        const nextLabel = newLevel || t('admin:users.regularUser');
        if (oldLabel === nextLabel) return;
        if (!(await confirm(t('admin:users.confirmLevel', { username: target?.username || userId, oldLabel, nextLabel })))) return;
        setProcessing(current => ({ ...current, [userId]: true }));
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
            };
            let res = await fetch(`${base}/admin/users/set-level`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ userId, admin_level: newLevel })
            });

            if (thisFetchId !== fetchIdRef.current) return; // stale

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${latest}`
                    };
                    res = await fetch(`${base}/admin/users/set-level`, {
                        method: 'POST',
                        headers: retryHeaders,
                        body: JSON.stringify({ userId, admin_level: newLevel })
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
                showTip(data.error || t('admin:users.updateFailedStatus', { status: res.status }));
                return;
            }

            showTip(t('admin:users.levelUpdated'));
            setUsers(list => list.map(u => u.id === userId ? { ...u, admin_level: newLevel || null } : u));
        } catch (e) {
            console.error('changeLevel failed', e);
            showTip(t('admin:users.failed', { message: e.message || e }));
        } finally {
            setProcessing(current => ({ ...current, [userId]: false }));
        }
    };

    const deleteUser = async (target) => {
        const id = target.id;
        if (!(await confirm(t('admin:users.confirmDelete', { username: target.username || id })))) return;
        setProcessing(current => ({ ...current, [id]: true }));
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/users/${id}`, {
                method: 'DELETE',
                headers
            });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/users/${id}`, { method: 'DELETE', headers: retryHeaders });
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

            showTip(t('admin:users.deleted'));
            setUsers(list => list.filter(u => u.id !== id));
        } catch (e) {
            console.error('deleteUser failed', e);
            showTip(t('admin:users.failed', { message: e.message || e }));
        } finally {
            setProcessing(current => ({ ...current, [id]: false }));
        }
    };

    const onBanClick = (u) => {
        setBanTarget(u);
        setBanModalOpen(true);
    };

    const handleBanConfirm = async ({ reason, durationDays }) => {
        if (!banTarget) return;
        const id = banTarget.id;
        setProcessing(p => ({ ...p, [id]: true }));
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            };
            // durationDays: null -> no expiry (should be treated as permanent by backend)
            const body = { userId: id, reason };
            if (durationDays !== null) body.durationDays = durationDays;
            const res = await fetch(`${base}/admin/users/ban`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                showTip(data.error || t('admin:users.banFailedStatus', { status: res.status }));
                return;
            }
            setUsers(list => list.map(x => x.id === id ? { ...x, is_banned: 1, ban_reason: reason || null, ban_expires: data && data.ban_expires ? data.ban_expires : null } : x));
            showTip(t('admin:users.banned'));
        } catch (e) {
            console.error('banUser failed', e);
            showTip(t('admin:users.banFailed', { message: e.message || e }));
        } finally {
            setProcessing(p => ({ ...p, [banTarget.id]: false }));
            setBanModalOpen(false);
            setBanTarget(null);
        }
    };

    const unbanUser = async (target) => {
        const id = target.id;
        if (!(await confirm(t('admin:users.confirmUnban', { username: target.username || id })))) return;
        setProcessing(p => ({ ...p, [id]: true }));
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            };
            const res = await fetch(`${base}/admin/users/unban`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ userId: id })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                showTip(data.error || t('admin:users.unbanFailedStatus', { status: res.status }));
                return;
            }
            showTip(t('admin:users.unbanned'));
            setUsers(list => list.map(u => u.id === id ? { ...u, is_banned: 0, ban_reason: null, ban_expires: null } : u));
        } catch (e) {
            console.error('unbanUser failed', e);
            showTip(t('admin:users.unbanFailed', { message: e.message || e }));
        } finally {
            setProcessing(p => ({ ...p, [id]: false }));
        }
    };

    // 改绑 QQ 号（留空即解绑）；失败时保留弹窗，便于改正后重试
    const saveQq = async (qq) => {
        const target = qqTarget;
        if (!target) return;
        setProcessing(p => ({ ...p, [target.id]: true }));
        try {
            const res = await fetch(`${base}/admin/users/set-qq`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ userId: target.id, qq })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setUsers(list => list.map(u => u.id === target.id ? { ...u, qq: data.qq } : u));
                showTip(t('admin:users.qqUpdated'));
                setQqTarget(null);
            } else if (res.status === 401) handleUnauthorized();
            else showTip(data.error || t('admin:users.qqFailed', { message: res.status }));
        } catch (e) {
            showTip(t('admin:users.qqFailed', { message: e.message || e }));
        } finally {
            setProcessing(p => ({ ...p, [target.id]: false }));
        }
    };

    if (!canManage) return <div style={{ color: 'var(--color-danger)' }}>{t('admin:common.error.noPanelAccess')}</div>;

    const PAGE_SIZE = 10;

    const filtered = users.filter(u => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return String(u.id).includes(q) ||
            (u.username && u.username.toLowerCase().includes(q)) ||
            (u.qq && String(u.qq).toLowerCase().includes(q));
    });

    const totalPages = Math.max(1, Math.ceil((filtered || []).length / PAGE_SIZE));
    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [totalPages, page]);

    const pageItems = (filtered || []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const renderAvatar = (target) => (
        <img
            src={target.has_avatar ? `${backendUrl}/users/${target.id}/avatar?t=${Date.now()}` : defaultAvatar}
            alt={t('common:label.avatar')}
            style={{ width: 42, height: 42, borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--color-border)' }}
        />
    );
    const renderUserActions = (target) => {
        const protectedTarget = target.id === user?.id || target.admin_level === 'YUYUKO';
        const levelItems = [
            ['YUYUKO', t('admin:users.setYuyuko')],
            ['YOUMU', t('admin:users.setYoumu')],
            ['KOMACHI', t('admin:users.setKomachi')],
            ['', t('admin:users.setRegular')]
        ].map(([value, label]) => ({
            key: `level-${value || 'user'}`,
            label,
            disabled: protectedTarget || (target.admin_level || '') === value,
            onClick: () => changeLevel(target.id, value)
        }));
        return (
            <ActionMenu
                disabled={processing[target.id]}
                items={[
                    ...levelItems,
                    { key: 'qq', label: t('admin:users.editQq'), onClick: () => setQqTarget(target) },
                    target.is_banned
                        ? { key: 'unban', label: t('admin:users.unban'), disabled: protectedTarget, onClick: () => unbanUser(target) }
                        : { key: 'ban', label: t('admin:users.ban'), tone: 'warning', disabled: protectedTarget, onClick: () => onBanClick(target) },
                    { key: 'delete', label: t('admin:users.delete'), tone: 'danger', disabled: protectedTarget, onClick: () => deleteUser(target) }
                ]}
            />
        );
    };

    return (
        <div>
            <h2>{t('admin:users.title')}</h2>
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <TextInput
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                    placeholder={t('admin:users.searchPlaceholder')}
                    style={{ flex: 1 }}
                />
                <Button themeAware onClick={fetchUsers} disabled={loading}>{t('common:action.refresh')}</Button>
            </div>
            {loading ? (
                <div>{t('common:status.loading')}</div>
            ) : filtered.length === 0 ? (
                <div>{t('admin:users.noMatch')}</div>
            ) : (
                isMobile ? (
                    <div style={{ display: 'grid', gap: 10 }}>
                        {pageItems.map((target) => (
                            <article key={target.id} style={{ padding: 12, borderRadius: 12, border: '1px solid var(--color-border)', background: 'var(--color-bg-surface)', boxShadow: '0 3px 12px rgba(18,16,22,.06)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    {renderAvatar(target)}
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{target.username}</div>
                                        <div style={{ marginTop: 3, fontSize: 12, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{tx('admin:users.idLine', { id: target.id })}</div>
                                    </div>
                                    {renderUserActions(target)}
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', marginTop: 12, fontSize: 13 }}>
                                    <span style={{ color: 'var(--color-text-secondary)' }}>{t('admin:users.level')}</span><span>{target.admin_level || t('admin:users.regularUser')}</span>
                                    <span style={{ color: 'var(--color-text-secondary)' }}>QQ</span><span>{target.qq || '-'}</span>
                                    <span style={{ color: 'var(--color-text-secondary)' }}>{t('admin:users.status')}</span><span style={{ color: target.is_banned ? 'var(--color-danger)' : 'var(--color-success)' }}>{target.is_banned ? t('admin:users.statusBanned') : t('admin:users.statusNormal')}</span>
                                </div>
                            </article>
                        ))}
                    </div>
                ) : (
                <ResponsiveTable minWidth={900} cellPadding="8" style={{ border: '1px solid var(--color-border)' }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: 'left', padding: 8, minWidth: 100 }}>ID</th>
                            <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:users.col.username')}</th>
                            <th style={{ textAlign: 'left', padding: 8 }}>{t('common:label.qq')}</th>
                            <th style={{ textAlign: 'left', padding: 8 }}>{t('common:label.avatar')}</th>
                            <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:users.level')}</th>
                            <th style={{ textAlign: 'left', padding: 8, maxWidth: 100 }}>{t('admin:common.table.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {pageItems.map((u, idx) => {
                            return (
                                <tr key={u.id} style={{ background: idx % 2 === 0 ? 'var(--color-bg-overlay)' : undefined }}>
                                    <td style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.id}>{u.id}</td>
                                    <td>{u.username}</td>
                                    <td>{u.qq || "-"}</td>
                                    <td>{renderAvatar(u)}</td>
                                    <td>{u.admin_level || t('admin:users.regularUser')}</td>
                                    <td style={{ whiteSpace: 'normal', maxWidth: 100 }}>
                                        {renderUserActions(u)}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </ResponsiveTable>
                )
            )}

            {!loading && filtered.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div>{tx('admin:common.pagination.summary', { count: filtered.length, page, totalPages })}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Button themeAware onClick={() => setPage(1)} disabled={page === 1}>{t('admin:common.pagination.first')}</Button>
                        <Button themeAware onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>{t('admin:common.pagination.prev')}</Button>
                        <Button themeAware onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>{t('admin:common.pagination.next')}</Button>
                        <Button themeAware onClick={() => setPage(totalPages)} disabled={page === totalPages}>{t('admin:common.pagination.last')}</Button>
                    </div>
                </div>
            )}

            <AdminBanModal open={banModalOpen} onClose={() => { setBanModalOpen(false); setBanTarget(null); }} onConfirm={handleBanConfirm} targetUser={banTarget} />
            <AdminQqModal open={!!qqTarget} onClose={() => setQqTarget(null)} onConfirm={saveQq} targetUser={qqTarget}
                saving={!!(qqTarget && processing[qqTarget.id])} />
        </div>
    );
}
