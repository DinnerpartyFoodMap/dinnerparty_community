import React from 'react';
import IconButton from "../../components/primitives/IconButton";
import ScrollableView from "../../components/layout/ScrollableView";
import ResponsivePanel from "../../components/overlay/ResponsivePanel";
import { t } from "../../i18n/index.js";

// 管理员修改记录：宽屏为右侧面板，窄屏为底部面板，只读。
export default function CommentPanel({ open = true, place, onClose, onRefresh, loading, ...rest }) {
    return (
        <ResponsivePanel
            open={open && !!place}
            onClose={onClose}
            title={t('map:editEvidence.history')}
            kind="comments"
            desktop="side-right"
            mobile="sheet"
            width="min(440px, calc(100vw - 80px))"
            sideInset={64}
            headerExtra={<IconButton icon="refresh" label={t('common:action.refresh')} onClick={onRefresh} disabled={loading} spinning={loading} />}
            bodyStyle={{ padding: 12 }}
        >
            {place && <CommentBody place={place} loading={loading} {...rest} />}
        </ResponsivePanel>
    );
}

function CommentBody({
    place,
    comments = [],
    loading,
    message
}) {
    return (
        <div>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>{place.name}</div>
            <ScrollableView style={{ maxHeight: 320, overflowY: 'auto', paddingTop: 4 }}>
                {loading ? (
                    <div>{t('common:status.loading')}</div>
                ) : (
                    <div>
                        {(!comments || comments.length === 0) ? (
                            <div style={{ color: 'var(--color-text-secondary)' }}>{t('map:comments.empty')}</div>
                        ) : (
                            comments.map(c => (
                                <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                                    <div style={{ fontSize: 13, whiteSpace:'pre-wrap', color: 'var(--color-text-primary)' }}>{c.content}</div>
                                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>{c.username || t('map:comments.anonymous')} · {c.time || c.created_time || c.createdTime || '-'}</div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </ScrollableView>

            {message && <div role="alert" style={{ color: 'var(--color-danger)', marginTop:8 }}>{message}</div>}
        </div>
    );
}
