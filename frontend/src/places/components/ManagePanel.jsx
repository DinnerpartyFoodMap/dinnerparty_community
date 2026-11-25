import React from 'react';
import Button from "../../components/primitives/Button";
import TextInput from "../../components/forms/TextInput";
import TextArea from "../../components/forms/TextArea";
import PlaceImageInputs from "./PlaceImageInputs";
import ScrollableView from "../../components/layout/ScrollableView";
import CategorySelector from './CategorySelector';
import ResponsivePanel from "../../components/overlay/ResponsivePanel";
import { t } from "../../i18n/index.js";
import { RATING_TIERS } from '../rating';
import { editCommentPreview } from '../editEvidence';
import { COMMENT_MAX_LENGTH, commentLength } from '../placeComments';

// 管理地点：宽屏居中表单，窄屏底部面板。保存（或提交修改申请）在标题栏右侧，左侧关闭钮即取消；删除在内容最下方（设计参考 11.4）
// mode="comment" 是同一个面板的评论模式：只有评论与评价两项（usePlaceCommentForm），提交在标题栏右侧，删除自己的评论在最下方。
export default function ManagePanel({ open = true, onClose, selectedPlace, mode = 'edit', ...rest }) {
    const comment = mode === 'comment';
    const direct = !comment && !!selectedPlace && typeof rest.canDirectManage === 'function' && rest.canDirectManage();
    const onHeaderAction = comment ? () => rest.commentForm?.submit() : (direct ? rest.onSave : rest.onSubmitRequest);
    const headerLabel = comment ? t('map:placeComments.form.submit') : (direct ? t('common:action.save') : t('map:manage.submitRequest'));
    const busy = comment ? !!rest.commentForm?.form?.submitting : rest.manageSubmitting;
    const title = !selectedPlace ? (comment ? t('map:placeComments.form.title') : t('map:manage.title'))
        : (comment ? t('map:placeComments.form.titleWithName', { name: selectedPlace.name }) : t('map:manage.titleWithName', { name: selectedPlace.name }));
    return (
        <ResponsivePanel
            open={open && !!selectedPlace}
            onClose={onClose}
            title={title}
            headerExtra={selectedPlace && (
                <Button variant="plain" onClick={onHeaderAction} disabled={busy}
                    style={{ padding: '0 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {headerLabel}
                </Button>
            )}
            kind={comment ? 'place-comment' : 'manage-place'}
            desktop="center"
            mobile="sheet"
            width="min(520px, calc(100vw - 24px))"
            bodyStyle={{ padding: 12 }}
        >
            {selectedPlace && (comment
                ? <CommentForm commentForm={rest.commentForm} />
                : <ManageForm selectedPlace={selectedPlace} onClose={onClose} {...rest} />)}
        </ResponsivePanel>
    );
}

function CommentForm({ commentForm }) {
    const form = commentForm?.form;
    if (!form) return null;
    const length = commentLength(form.content);
    return (
        <div style={{ color: 'var(--color-text-primary)' }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:placeComments.form.comment')}</label>
            <TextArea
                value={form.content}
                maxLength={COMMENT_MAX_LENGTH}
                placeholder={t('map:placeComments.form.placeholder')}
                onChange={(e) => commentForm.setContent(e.target.value)}
                disabled={form.submitting}
                rows={4}
                style={{
                    width: '100%',
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-bg-overlay)',
                    color: 'var(--color-text-primary)'
                }}
            />
            <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <span>{t('map:placeComments.form.notice')}</span>
                <span style={{ flexShrink: 0 }}>{t('map:placeComments.form.count', { count: length, max: COMMENT_MAX_LENGTH })}</span>
            </div>
            {form.status === 'rejected' && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-warning-text)' }}>{t('map:placeComments.form.rejectedNotice')}</div>
            )}
            <fieldset style={{ marginTop: 12 }} disabled={form.submitting}>
                <legend>{t('map:placeComments.form.rating')}</legend>
                {RATING_TIERS.map((tier) => (
                    <label key={tier.score} style={{ display: 'block', padding: 4 }}>
                        <input type="radio" name="comment-rating" value={tier.score} checked={form.rating === tier.score} onChange={() => commentForm.setRating(tier.score)} />
                        {tier.label}
                    </label>
                ))}
            </fieldset>
            {form.message && <div role="alert" style={{ marginTop: 8, color: 'var(--color-danger-text)' }}>{form.message}</div>}
            {form.commentId != null && (
                <Button variant="destructive" full onClick={() => commentForm.remove({ confirmFirst: true })} disabled={form.submitting} style={{ marginTop: 16 }}>
                    {t('map:placeComments.form.delete')}
                </Button>
            )}
        </div>
    );
}

function ManageForm({
    backendUrl,
    token,
    selectedPlace,
    manageEdit,
    setManageEdit,
    manageSubmitting,
    manageMessage,
    canDirectManage,
    onClose,
    onSave,
    onDelete,
    onSubmitRequest,
    onPickPosition
}) {
    return (
        <div>
            <div style={{ color: 'var(--color-text-primary)' }}>
                <div>
                    <label style={{ display: "block", fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:manage.field.name')}</label>
                    <TextInput value={manageEdit.name} onChange={(e) => setManageEdit(me => ({ ...me, name: e.target.value }))} style={{ width: "100%" }} />
                </div>
                <div style={{ marginTop: 8 }}>
                    <label style={{ display: "block", fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:manage.field.category')}</label>
                    <CategorySelector
                        backendUrl={backendUrl}
                        token={token}
                        value={manageEdit.category || ''}
                        onChange={(category) => setManageEdit(me => ({ ...me, category }))}
                    />
                </div>
                <div style={{ marginTop: 8 }}>
                    <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:manage.field.position')}</label>
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <span style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
                            {t('map:manage.coordinates', {
                                longitude: Number(manageEdit.longitude).toFixed(6),
                                latitude: Number(manageEdit.latitude).toFixed(6)
                            })}
                        </span>
                        <Button onClick={onPickPosition} disabled={manageSubmitting}>{t('map:manage.modifyPosition')}</Button>
                    </div>
                </div>
                <div style={{ marginTop: 8 }}>
                    <label style={{ display: "block", fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:common.label.description')}</label>
                    <ScrollableView
                        as={TextArea}
                        markdown
                        maxLength={1000}
                        value={manageEdit.description}
                        onChange={(e) => setManageEdit(me => ({ ...me, description: e.target.value }))}
                        style={{
                            width: "100%",
                            maxHeight: "150px",
                            border: '1px solid var(--color-border)',
                            background: 'var(--color-bg-overlay)',
                            color: 'var(--color-text-primary)'
                        }}
                    />
                </div>
                <div style={{ marginTop: 8 }}>
                    <label style={{ display: "block", fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:manage.field.perPersonCost')}</label>
                    <TextInput
                        value={manageEdit.per_person_cost != null ? String(manageEdit.per_person_cost) : ''}
                        onChange={(e) => {
                            const v = e.target.value;
                            if (v === '') {
                                setManageEdit(me => ({ ...me, per_person_cost: null }));
                            } else if (/^[1-9]\d*$/.test(v)) {
                                setManageEdit(me => ({ ...me, per_person_cost: parseInt(v, 10) }));
                            }
                        }}
                        style={{ width: "100%" }}
                        placeholder={t('map:manage.field.perPersonCostPlaceholder')}
                        inputMode="numeric"
                    />
                </div>
                <ScrollableView style={{ marginTop: 8, maxHeight: "150px", overflowY: "auto" }}>
                    <PlaceImageInputs backendUrl={backendUrl} token={token} images={manageEdit.exterior_images || []} setImages={(imgs) => setManageEdit(me => ({ ...me, exterior_images: imgs }))} label={t('map:manage.field.exteriorImages')} />
                    <PlaceImageInputs backendUrl={backendUrl} token={token} images={manageEdit.menu_images || []} setImages={(imgs) => setManageEdit(me => ({ ...me, menu_images: imgs }))} label={t('map:manage.field.menuImages')} />
                </ScrollableView>
                {!canDirectManage() && (
                    <div style={{ marginTop: 10, color: 'var(--color-text-secondary)', fontSize: 12 }}>{t('map:manage.needsReview')}</div>
                )}
                {!manageEdit.has_rating && <div style={{marginTop:12}}>
                    <label><input type="checkbox" checked={!!manageEdit.no_experience} onChange={e=>setManageEdit(me=>({...me,no_experience:e.target.checked,rating:null}))}/>{t('map:editEvidence.noExperience')}</label>
                    {!manageEdit.no_experience && <fieldset style={{marginTop:8}}><legend>{t('map:editEvidence.ratingRequired')}</legend>
                        {RATING_TIERS.map(tier=><label key={tier.score} style={{display:'block',padding:4}}><input type="radio" name="edit-rating" value={tier.score} checked={manageEdit.rating===tier.score} onChange={()=>setManageEdit(me=>({...me,rating:tier.score}))}/>{tier.label}</label>)}
                    </fieldset>}
                </div>}
                <div style={{marginTop:12}}><div>{t('map:editEvidence.preview')}</div>
                    <p style={{fontSize:12,color:'var(--color-text-secondary)'}}>{t('map:editEvidence.notice')}</p>
                    <div style={{whiteSpace:'pre-wrap',fontSize:13,maxHeight:180,overflowY:'auto'}}>{editCommentPreview(selectedPlace,manageEdit)||t('map:editEvidence.noChanges')}</div>
                </div>
                {manageMessage && <div role="alert" style={{ marginTop: 8, color: 'var(--color-danger-text)' }}>{manageMessage}</div>}
                {canDirectManage() && (
                    <Button variant="destructive" full onClick={onDelete} disabled={manageSubmitting} style={{ marginTop: 16 }}>{t('common:action.delete')}</Button>
                )}
            </div>
        </div>
    );
}
