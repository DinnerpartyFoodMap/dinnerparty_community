import React from 'react';
import Button from "../../components/primitives/Button";
import TextInput from "../../components/forms/TextInput";
import TextArea from "../../components/forms/TextArea";
import PlaceImageInputs from "./PlaceImageInputs";
import ScrollableView from "../../components/layout/ScrollableView";
import CategorySelector from './CategorySelector';
import ResponsivePanel from "../../components/overlay/ResponsivePanel";
import { t } from "../../i18n/index.js";

// 管理地点：宽屏居中表单，窄屏底部面板
export default function ManagePanel({ open = true, onClose, selectedPlace, ...rest }) {
    return (
        <ResponsivePanel
            open={open && !!selectedPlace}
            onClose={onClose}
            title={selectedPlace ? t('map:manage.titleWithName', { name: selectedPlace.name }) : t('map:manage.title')}
            kind="manage-place"
            desktop="center"
            mobile="sheet"
            width="min(520px, calc(100vw - 24px))"
            bodyStyle={{ padding: 12 }}
        >
            {selectedPlace && <ManageForm selectedPlace={selectedPlace} onClose={onClose} {...rest} />}
        </ResponsivePanel>
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
                        <Button themeAware onClick={onPickPosition} disabled={manageSubmitting}>{t('map:manage.modifyPosition')}</Button>
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
                <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                    {!canDirectManage() && (
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{t('map:manage.needsReview')}</div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 8, flexShrink: 0, marginLeft: 'auto' }}>
                        <Button themeAware onClick={onClose} style={{ whiteSpace: 'nowrap' }}>{t('common:action.cancel')}</Button>

                        {canDirectManage() ? (
                            <>
                                <Button themeAware onClick={onSave} disabled={manageSubmitting} style={{ whiteSpace: 'nowrap' }}>{t('common:action.save')}</Button>
                                <Button themeAware onClick={onDelete} disabled={manageSubmitting} style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', borderColor: 'var(--color-danger)', whiteSpace: 'nowrap' }}>{t('common:action.delete')}</Button>
                            </>
                        ) : (
                            <Button themeAware onClick={onSubmitRequest} disabled={manageSubmitting} style={{ whiteSpace: 'nowrap' }}>{t('map:manage.submitRequest')}</Button>
                        )}
                    </div>
                </div>

                {manageMessage && <div style={{ marginTop: 8, color: 'var(--color-danger)' }}>{manageMessage}</div>}
            </div>
        </div>
    );
}
