import React, { useEffect, useMemo, useRef, useState } from 'react';
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import TextArea from "../components/forms/TextArea";
import Notice from "../components/feedback/Notice";
import ResponsiveTable from "../components/data/ResponsiveTable";
import { useTips } from "../components/feedback/Tips";
import { useConfirm } from "../components/feedback/Confirm";
import { useAuth } from "../auth/AuthContext";
import useDarkMode from "../theme/useDarkMode";
import { NOTICE_COLOR_OPTIONS, getNoticeColorOption } from "../components/feedback/noticeColors";
import { getApiBaseUrl } from '../platform/runtimeConfig';
import { peekToken } from '../platform/credentialStore';
import { t } from '../i18n/index.js';

function resolveBackendUrl() {
    return getApiBaseUrl();
}

function getLatestStoredToken() {
    return peekToken();
}

export default function AdminNotices({ backendUrl = null }) {
    const base = backendUrl || resolveBackendUrl();
    const { token, user, onRequireAuth } = useAuth();
    const dark = useDarkMode();
    const showTip = useTips();
    const confirm = useConfirm();
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [notices, setNotices] = useState([]);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [colorKey, setColorKey] = useState(NOTICE_COLOR_OPTIONS[0].key);
    const fetchIdRef = useRef(0);

    const canManage = !!(user && user.admin_level);

    const currentNotice = useMemo(() => {
        return (notices || []).find((item) => item && item.is_active) || null;
    }, [notices]);

    useEffect(() => {
        if (!canManage) return;
        fetchNotices();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canManage, token]);

    const handleUnauthorized = () => {
        setNotices([]);
        showTip(t('admin:common.error.sessionExpired'));
        if (onRequireAuth) onRequireAuth();
    };

    const fetchNotices = async () => {
        setLoading(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/notices`, { headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    res = await fetch(`${base}/admin/notices`, { headers: { Authorization: `Bearer ${latest}` } });
                    if (thisFetchId !== fetchIdRef.current) return;
                }
            }

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (res.status === 401) {
                    handleUnauthorized();
                    return;
                }
                if (res.status === 403) {
                    showTip(t('admin:notices.forbidden'));
                    return;
                }
                throw new Error(data.error || t('admin:notices.loadFailedStatus', { status: res.status }));
            }

            const data = await res.json().catch(() => []);
            setNotices(Array.isArray(data) ? data : []);
        } catch (e) {
            console.error('加载公告失败', e);
            showTip(t('admin:notices.loadFailed', { message: e.message || e }));
        } finally {
            setLoading(false);
        }
    };

    const publishNotice = async () => {
        const nextTitle = title.trim();
        const nextContent = content.trim();
        if (!nextTitle || !nextContent) {
            showTip(t('admin:notices.fillRequired'));
            return;
        }
        setSubmitting(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
            };
            let res = await fetch(`${base}/admin/notices`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ title: nextTitle, content: nextContent, color_key: colorKey })
            });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    res = await fetch(`${base}/admin/notices`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${latest}`
                        },
                        body: JSON.stringify({ title: nextTitle, content: nextContent, color_key: colorKey })
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
                throw new Error(data.error || t('admin:notices.publishFailedStatus', { status: res.status }));
            }

            showTip(t('admin:notices.published'));
            setTitle('');
            setContent('');
            await fetchNotices();
        } catch (e) {
            console.error('发布公告失败', e);
            showTip(t('admin:notices.publishFailed', { message: e.message || e }));
        } finally {
            setSubmitting(false);
        }
    };

    const clearCurrentNotice = async () => {
        if (!(await confirm(t('admin:notices.confirmUnpublish')))) return;
        setClearing(true);
        const thisFetchId = ++fetchIdRef.current;
        const authToken = token;
        try {
            const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
            let res = await fetch(`${base}/admin/notices/current`, { method: 'DELETE', headers });

            if (thisFetchId !== fetchIdRef.current) return;

            if (res.status === 401) {
                const latest = token || getLatestStoredToken();
                if (latest && latest !== authToken) {
                    res = await fetch(`${base}/admin/notices/current`, {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${latest}` }
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
                throw new Error(data.error || t('admin:notices.unpublishFailedStatus', { status: res.status }));
            }

            showTip(t('admin:notices.unpublished'));
            await fetchNotices();
        } catch (e) {
            console.error('下线公告失败', e);
            showTip(t('admin:notices.unpublishFailed', { message: e.message || e }));
        } finally {
            setClearing(false);
        }
    };

    if (!canManage) return <div style={{ color: 'var(--color-danger)' }}>{t('admin:common.error.noPanelAccess')}</div>;

    const previewNotice = {
        title: title.trim() || t('admin:notices.previewTitle'),
        content: content.trim() || t('admin:notices.previewContent')
    };

    return (
        <div style={{ marginTop: 12 }}>
            <h3>{t('admin:notices.title')}</h3>
            <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button themeAware onClick={fetchNotices} disabled={loading}>{t('common:action.refresh')}</Button>
                <Button themeAware onClick={clearCurrentNotice} disabled={clearing || !currentNotice}>{t('admin:notices.unpublish')}</Button>
            </div>

            {currentNotice ? (
                <div style={{ marginBottom: 16 }}>
                    <div style={{ marginBottom: 8, fontWeight: 700 }}>{t('admin:notices.currentTitle')}</div>
                    <Notice
                        title={currentNotice.title}
                        backgroundColor={getNoticeColorOption(currentNotice.color_key).backgroundColor}
                        style={{ position: 'relative', top: 'auto', left: 'auto', transform: 'none', width: '96.5%', maxWidth: 'none', minWidth: 0, marginBottom: 0, textAlign: 'center' }}
                    >
                        <div style={{ whiteSpace: 'pre-wrap' }}>{currentNotice.content}</div>
                    </Notice>
                </div>
            ) : (
                <div style={{ marginBottom: 16, color: 'var(--color-text-secondary)' }}>{t('admin:notices.noCurrent')}</div>
            )}

            <div style={{ marginBottom: 12, padding: 12, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg-overlay)' }}>
                <div style={{ marginBottom: 10, fontWeight: 700 }}>{t('admin:notices.newTitle')}</div>
                <div style={{ display: 'grid', gap: 10 }}>
                    <TextInput
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={t('admin:notices.titlePlaceholder')}
                        maxLength={80}
                    />
                    <TextArea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={t('admin:notices.contentPlaceholder')}
                        rows={5}
                        maxLength={1000}
                    />
                    <div>
                        <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('admin:notices.chooseColor')}</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {NOTICE_COLOR_OPTIONS.map((option) => (
                                <button
                                    key={option.key}
                                    type="button"
                                    title={option.label}
                                    aria-label={option.label}
                                    onClick={() => setColorKey(option.key)}
                                    style={{
                                        width: 34,
                                        height: 34,
                                        padding: 0,
                                        borderRadius: '50%',
                                        border: colorKey === option.key ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                                        background: option.backgroundColor,
                                        boxSizing: 'border-box',
                                        cursor: 'pointer'
                                    }}
                                />
                            ))}
                        </div>
                    </div>

                    <div style={{ marginTop: 6 }}>
                        <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('admin:notices.preview')}</div>
                        <Notice
                            title={previewNotice.title}
                            backgroundColor={getNoticeColorOption(colorKey).backgroundColor}
                            style={{ position: 'relative', top: 'auto', left: 'auto', transform: 'none', width: '96.5%', maxWidth: 'none', minWidth: 0, textAlign: 'center' }}
                        >
                            <div style={{ whiteSpace: 'pre-wrap' }}>{previewNotice.content}</div>
                        </Notice>
                    </div>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Button themeAware onClick={publishNotice} disabled={submitting}>{t('admin:notices.publish')}</Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
