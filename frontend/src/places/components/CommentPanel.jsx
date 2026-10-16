import React from 'react';
import Button from "../../components/primitives/Button";
import TextArea from "../../components/forms/TextArea";
import ScrollableView from "../../components/layout/ScrollableView";
import ResponsivePanel from "../../components/overlay/ResponsivePanel";
import { t } from "../../i18n/index.js";

// 评论：宽屏为右侧面板，窄屏为底部面板
export default function CommentPanel({ open = true, place, onClose, onRefresh, loading, ...rest }) {
    return (
        <ResponsivePanel
            open={open && !!place}
            onClose={onClose}
            title={place ? place.name : t('map:comments.title')}
            kind="comments"
            desktop="side-right"
            mobile="sheet"
            width="min(440px, calc(100vw - 80px))"
            sideInset={64}
            headerExtra={<Button themeAware onClick={onRefresh} disabled={loading}>{t('common:action.refresh')}</Button>}
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
    message,
    newComment,
    setNewComment,
    submitting,
    onSubmit,
    canPost
}) {
    return (
        <div>
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
                                    <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{c.content}</div>
                                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>{c.user_id || c.userId || t('map:comments.anonymous')} · {c.created_time || c.createdTime || '-'}</div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </ScrollableView>

            <div style={{ marginTop: 8 }}>
                {message && <div style={{ color: 'var(--color-danger)', marginBottom: 8 }}>{message}</div>}
                <TextArea value={newComment} onChange={e => setNewComment(e.target.value)} placeholder={canPost ? t('map:comments.placeholder') : t('map:comments.loginRequired')} disabled={!canPost} style={{ width: '100%', minHeight: 80, padding: 8, boxSizing: 'border-box' }} />
                <div style={{ marginTop: 8, textAlign: 'right' }}>
                    <Button themeAware onClick={onSubmit} disabled={!canPost || submitting || !newComment || !newComment.trim()} style={{ marginRight: 8 }}>{t('map:comments.post')}</Button>
                </div>
            </div>
        </div>
    );
}
