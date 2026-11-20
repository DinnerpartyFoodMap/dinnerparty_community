import React from 'react';
import Button from '../../components/primitives/Button';
import TextArea from '../../components/forms/TextArea';
import ResponsivePanel from '../../components/overlay/ResponsivePanel';
import { t } from '../../i18n';
import { RATING_TIERS, tierLabel } from '../rating';
import { CHECK_IN_DESCRIPTION_LIMIT, CHECK_IN_PHOTO_LIMIT } from '../checkInSubmission';

// 地点打卡的网页面板。状态与提交在 usePlaceCheckIn（MapUI 持有），iOS 原生控件接管时改用原生玻璃面板（checkInChromeSheet），
// 两边是同一份状态。提交或选图期间不能关闭。
export default function PlaceCheckInPanel({ open, place, checkIn, onClose }) {
    const { description, score, photos, pending, error, receipt, retryRating } = checkIn;
    const submit = (event) => {
        event.preventDefault();
        checkIn.submit();
    };
    return (
        <ResponsivePanel open={open && !!place} onClose={pending ? undefined : onClose} title={t('map:checkIn.title')} kind="place-check-in" desktop="center" mobile="sheet">
            {place && <form onSubmit={submit} style={{ display: 'grid', gap: 14, padding: '0 16px 16px' }}>
                <p style={{ margin: 0 }}>{place.name}</p>
                {receipt ? (
                    <>
                        <p role="status" style={{ margin: 0 }}>{t('map:checkIn.success')}</p>
                        {Object.keys(receipt.reviews || {}).length > 0 && <p style={{ margin: 0 }}>{t('map:checkIn.review')}</p>}
                    </>
                ) : (
                    <>
                        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>{t('map:checkIn.distance')}</p>
                        <label style={{ display: 'grid', gap: 6 }}>
                            {t('map:checkIn.description')}
                            <TextArea value={description} maxLength={CHECK_IN_DESCRIPTION_LIMIT} rows={3}
                                onChange={event => checkIn.setDescription(event.target.value)} disabled={!!pending} />
                        </label>
                        <fieldset style={{ margin: 0, border: 0, padding: 0 }} disabled={!!pending}>
                            <legend>{t('map:checkIn.rating')}</legend>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                {RATING_TIERS.map(tier => (
                                    <Button key={tier.score} type="button" variant={score === tier.score ? 'primary' : 'secondary'}
                                        aria-pressed={score === tier.score} onClick={() => checkIn.toggleScore(tier.score)}>
                                        {tierLabel(tier)}
                                    </Button>
                                ))}
                            </div>
                        </fieldset>
                        <div>
                            <Button type="button" variant="secondary" onClick={() => checkIn.choosePhotos()} disabled={!!pending || photos.length >= CHECK_IN_PHOTO_LIMIT}>
                                {t('map:checkIn.photos', { count: photos.length })}
                            </Button>
                            {photos.map((photo) => <div key={photo.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                                <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{photo.file.name}</span>
                                <Button type="button" variant="secondary" size="sm" disabled={!!pending}
                                    onClick={() => checkIn.removePhoto(photo.id)}>{t('common:action.remove')}</Button>
                            </div>)}
                        </div>
                    </>
                )}
                {error && <div role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
                {receipt && !retryRating
                    ? <Button type="button" onClick={onClose}>{t('map:checkIn.done')}</Button>
                    : <Button type="submit" disabled={!!pending}>{pending === 'submit' ? t('map:checkIn.submitting')
                        : retryRating ? t('map:checkIn.retryRating') : t('map:checkIn.submit')}</Button>}
            </form>}
        </ResponsivePanel>
    );
}
