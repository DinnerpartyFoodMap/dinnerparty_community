import React, { useEffect, useState, useRef } from "react";
import Button from "../components/primitives/Button";
import { useAuth } from "../auth/AuthContext";
import ResponsiveTable from "../components/data/ResponsiveTable";
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

export default function AdminGeneralUsers({ backendUrl = null }) {
    const base = backendUrl || resolveBackendUrl();
    const { token, user, onRequireAuth } = useAuth();
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(false);
    const showTip = useTips();
    const confirm = useConfirm();
    const [processing, setProcessing] = useState({});
    const [searchQuery, setSearchQuery] = useState('');
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
            let res = await fetch(`${base}/admin/general-users`, { headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/general-users`, { headers: retryHeaders });
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
                    showTip(t('admin:generalUsers.forbidden'));
                    return;
                }
                throw new Error(t('admin:common.error.serverStatusDetail', { status: res.status, txt }));
            }

            const data = await res.json().catch(() => []);
            setUsers(data || []);
        } catch (e) {
            console.error('加载普通用户失败', e);
            if (e && String(e.message || '').toLowerCase().includes('未登录')) {
                // handled
            } else {
                showTip(t('admin:common.error.loadFailedWithMessage', { message: e.message || e }));
            }
        } finally {
            setLoading(false);
        }
    };

    const deleteUser = async (target) => {
        const id = target.id;
        if (!(await confirm(t('admin:generalUsers.confirmDelete', { username: target.username || id })))) return;
        setProcessing(p => ({ ...p, [id]: true }));
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/general-users/${id}`, { method: 'DELETE', headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    const retryHeaders = { Authorization: `Bearer ${latest}` };
                    res = await fetch(`${base}/admin/general-users/${id}`, { method: 'DELETE', headers: retryHeaders });
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

            showTip(t('admin:generalUsers.deleted'));
            setUsers(list => list.filter(u => u.id !== id));
        } catch (e) {
            console.error('deleteUser failed', e);
            showTip(t('common:error.deleteFailedWithMessage', { message: e.message || e }));
        } finally {
            setProcessing(p => ({ ...p, [id]: false }));
        }
    };

    if (!canManage) return <div style={{ color: 'var(--color-danger)' }}>{t('admin:common.error.noPanelAccess')}</div>;

    const filteredUsers = users.filter(u => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return String(u.id).includes(q) ||
            (u.username && u.username.toLowerCase().includes(q)) ||
            (u.qq && String(u.qq).toLowerCase().includes(q));
    });

    return (
        <div style={{ marginTop: 12 }}>
            <h3>{t('admin:generalUsers.title')}</h3>
            <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <input
                        type="text"
                        placeholder={t('admin:generalUsers.searchPlaceholder')}
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        style={{ padding: '6px 12px', width: '100%', boxSizing: 'border-box', border: '1px solid var(--color-border)', background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)', borderRadius: 'var(--radius-sm)' }}
                    />
                </div>
                <Button themeAware onClick={fetchUsers} disabled={loading}>{t('common:action.refresh')}</Button>
            </div>


            {loading ? (
                <div>{t('common:status.loading')}</div>
            ) : (
                <div>
                    {filteredUsers.length === 0 ? (
                        <div>{t('admin:generalUsers.empty')}</div>
                    ) : isMobile ? (
                        <div style={{ display: 'grid', gap: 10 }}>
                            {filteredUsers.map((target) => (
                                <article key={target.id} style={{ padding: 12, border: '1px solid var(--color-border)', borderRadius: 12, background: 'var(--color-bg-surface)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <img src={target.has_avatar ? `${backendUrl}/users/${target.id}/avatar?t=${Date.now()}` : defaultAvatar} alt={t('common:label.avatar')} style={{ width: 42, height: 42, borderRadius: '50%', objectFit: 'cover' }} />
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 700 }}>{target.username}</div>
                                            <div style={{ marginTop: 3, fontSize: 12, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{tx('admin:generalUsers.idLine', { id: target.id })}</div>
                                            <div style={{ marginTop: 3, fontSize: 12, color: 'var(--color-text-secondary)' }}>{tx('admin:generalUsers.qqLine', { qq: target.qq || '-' })}</div>
                                        </div>
                                        <ActionMenu disabled={processing[target.id]} items={[{ key: 'delete', label: t('admin:generalUsers.deleteAction'), tone: 'danger', onClick: () => deleteUser(target) }]} />
                                    </div>
                                </article>
                            ))}
                        </div>
                    ) : (
                        <ResponsiveTable minWidth={750} cellPadding="8" style={{ border: '1px solid var(--color-border)' }}>
                            <thead>
                                <tr>
                                    <th style={{ textAlign: 'left', padding: 8, minWidth: 100 }}>ID</th>
                                    <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:generalUsers.col.username')}</th>
                                    <th style={{ textAlign: 'left', padding: 8 }}>{t('common:label.qq')}</th>
                                    <th style={{ textAlign: 'left', padding: 8 }}>{t('common:label.avatar')}</th>
                                    <th style={{ textAlign: 'left', padding: 8, minWidth: 100 }}>{t('admin:common.table.actions')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredUsers.map((u, idx) => (
                                    <tr key={u.id} style={{ background: idx % 2 === 0 ? 'var(--color-bg-overlay)' : undefined }}>
                                        <td style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.id}>{u.id}</td>
                                        <td>{u.username}</td>
                                        <td>{u.qq || '-'}</td>
                                        <td>
                                            {u.has_avatar ? (
                                                <img src={`${backendUrl}/users/${u.id}/avatar?t=${Date.now()}`} alt="avatar" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />
                                            ) : (
                                                <img src={defaultAvatar} alt="default avatar" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />
                                            )}
                                        </td>
                                        <td style={{ minWidth: 100 }}>
                                            <ActionMenu disabled={processing[u.id]} items={[{ key: 'delete', label: t('admin:generalUsers.deleteAction'), tone: 'danger', onClick: () => deleteUser(u) }]} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </ResponsiveTable>
                    )}
                </div>
            )}
        </div>
    );
}
