import React, { useEffect, useState } from 'react';
import Button from "../components/primitives/Button";
import ResponsiveTable from "../components/data/ResponsiveTable";
import JsonTable from "../components/data/JsonTable";
import { getApiBaseUrl } from '../platform/runtimeConfig';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import { t } from '../i18n/index.js';

export default function AdminAuditModal({ open, onClose, backendUrl, token }) {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(false);
    const base = backendUrl || getApiBaseUrl();

    useEffect(() => {
        if (!open) return;
        fetchLogs();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const fetchLogs = async () => {
        setLoading(true);
        try {
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const res = await fetch(`${base}/admin/audit`, { headers });
            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                throw new Error(`Fetch failed ${res.status} ${txt}`);
            }
            const data = await res.json().catch(() => []);
            setLogs(data || []);
        } catch (e) {
            console.error('fetchLogs failed', e);
            setLogs([]);
        } finally {
            setLoading(false);
        }
    };

    return (
        <ResponsivePanel
            open={open}
            onClose={onClose}
            title={t('admin:auditModal.title')}
            kind="admin-audit"
            desktop="center"
            mobile="full"
            width="min(640px, calc(100vw - 24px))"
            maxHeight="80%"
            bodyStyle={{ padding: 12 }}
        >
                <div style={{ marginTop: 8 }}>
                    {loading ? (
                        <div>{t('common:status.loading')}</div>
                    ) : (
                        <div>
                            {logs.length === 0 ? (
                                <div style={{ color: 'var(--color-text-secondary)' }}>{t('admin:auditModal.empty')}</div>
                            ) : (
                                <ResponsiveTable minWidth={1240} cellPadding="8" style={{ border: '1px solid var(--color-border)' }}>
                                    <thead>
                                        <tr>
                                            <th style={{ textAlign: 'left', padding: 8, minWidth: 80 }}>ID</th>
                                            <th style={{ textAlign: 'left', padding: 8, minWidth: 160 }}>{t('admin:auditModal.col.operator')}</th>
                                            <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:auditModal.col.action')}</th>
                                            <th style={{ textAlign: 'left', padding: 8, minWidth: 160 }}>{t('admin:auditModal.col.target')}</th>
                                            <th style={{ textAlign: 'left', padding: 8, minWidth: 120 }}>IP</th>
                                            <th style={{ textAlign: 'left', padding: 8, minWidth: 180 }}>{t('admin:auditModal.col.requestId')}</th>
                                            <th style={{ textAlign: 'left', padding: 8 }}>{t('admin:auditModal.col.detail')}</th>
                                            <th style={{ textAlign: 'left', padding: 8, minWidth: 100 }}>{t('admin:auditModal.col.time')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {logs.map((l, idx) => (
                                            <tr key={l.id} style={{ borderTop: '1px solid var(--color-border)', background: idx % 2 === 0 ? 'var(--color-bg-overlay)' : undefined }}>
                                                <td style={{ padding: 8, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.id}>{l.id}</td>
                                                <td style={{ padding: 8, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.admin_id}>{l.admin_id || '-'}</td>
                                                <td style={{ padding: 8 }}>{l.action}</td>
                                                <td style={{ padding: 8, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.target_user_id}>{l.target_user_id || '-'}</td>
                                                <td style={{ padding: 8 }}>{l.ip || '-'}</td>
                                                <td style={{ padding: 8, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.request_id}>{l.request_id || '-'}</td>
                                                <td style={{ padding: 8, maxWidth: 320, verticalAlign: 'top' }}>
                                                    {l.details ? (
                                                        <div style={{ maxWidth: 320 }}>
                                                            <JsonTable value={l.details} />
                                                        </div>
                                                    ) : '-'}
                                                </td>
                                                <td style={{ padding: 8 }}>{l.time}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </ResponsiveTable>
                            )}
                        </div>
                    )}
                </div>
        </ResponsivePanel>
    );
}
