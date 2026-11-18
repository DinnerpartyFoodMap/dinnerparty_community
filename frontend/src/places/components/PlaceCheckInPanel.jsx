import { useEffect, useRef, useState } from 'react';
import Button from '../../components/primitives/Button';
import TextArea from '../../components/forms/TextArea';
import ResponsivePanel from '../../components/overlay/ResponsivePanel';
import { getFreshLocation } from '../../platform/geolocation';
import { isAppActive } from '../../platform/lifecycle';
import { pickImages, prepareImageForUpload } from '../../platform/mediaPicker';
import { t } from '../../i18n';
import { RATING_TIERS, tierLabel } from '../rating';
import { ratingRequestId } from '../../api/client';
import { submitCheckIn } from '../checkInSubmission';

const PHOTO_LIMIT = 3;
const PHOTO_UPLOAD_LIMITS = { maxBytes: 3 * 1024 * 1024, targetBytes: 1024 * 1024, maxDimension: 1600, quality: 0.83 };

export default function PlaceCheckInPanel({ place, backendUrl, token, onClose, onSuccess }) {
    const [description, setDescription] = useState('');
    const [score, setScore] = useState(null);
    const [photos, setPhotos] = useState([]);
    const [pending, setPending] = useState('');
    const [error, setError] = useState('');
    const [receipt, setReceipt] = useState(null);
    const requestId = useRef(null);
    const controller = useRef(null);
    useEffect(() => () => controller.current?.abort(), []);

    const resetAttempt = () => { requestId.current = null; setError(''); };

    async function choosePhotos() {
        setPending('photos');
        setError('');
        try {
            const files = await pickImages({ multiple: true, limit: PHOTO_LIMIT - photos.length });
            const ready = await Promise.all(files.map(file => prepareImageForUpload(file, PHOTO_UPLOAD_LIMITS)));
            if (ready.length) {
                setPhotos(current => [...current, ...ready].slice(0, PHOTO_LIMIT));
                resetAttempt();
            }
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending('');
        }
    }

    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        setPending('submit');
        setError('');
        const active = new AbortController();
        controller.current = active;
        try {
            const { ok, body: result } = await submitCheckIn({
                retry: !!requestId.current,
                hasReceipt: !!receipt,
                locate: () => getFreshLocation({ prompt: true, maxAccuracy: 25, signal: active.signal }),
                send: async fix => {
                    if (!isAppActive()) throw new Error(t('map:checkIn.failed'));
                    requestId.current ||= ratingRequestId();
                    const body = new FormData();
                    const location = fix && { lat: fix.lat, lng: fix.lng, coordSystem: fix.coordSystem, source: fix.source,
                        timestamp: fix.timestamp, accuracy: fix.accuracy };
                    body.append('payload', JSON.stringify({ request_id: requestId.current, description, score, fix: location }));
                    for (const photo of photos) body.append('photos', photo, photo.name);
                    const response = await fetch(`${backendUrl}/places/${encodeURIComponent(place.id)}/check-ins`, {
                        method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: active.signal, body
                    });
                    const result = await response.json().catch(() => null);
                    if (response.ok && !result?.id) throw new Error(t('map:checkIn.failed'));
                    return { ok: response.ok, body: result || {} };
                }
            });
            if (!ok) throw new Error(result.error || t('map:checkIn.failed'));
            if (!receipt) window.dispatchEvent(new Event('foodmap:companion-fed'));
            setReceipt(result);
            onSuccess?.(result);
            if (result.rating_error) setError(result.rating_error);
        } catch (failure) {
            if (!active.signal.aborted) setError(failure.message || t('map:checkIn.failed'));
        } finally {
            if (!active.signal.aborted) setPending('');
        }
    }

    const retryRating = receipt && score !== null && !receipt.rating_saved && receipt.rating_retryable !== false;
    return (
        <ResponsivePanel open onClose={pending ? undefined : onClose} title={t('map:checkIn.title')} kind="place-check-in" desktop="center" mobile="sheet">
            <form onSubmit={submit} style={{ display: 'grid', gap: 14, padding: '0 16px 16px' }}>
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
                            <TextArea value={description} maxLength={1000} rows={3}
                                onChange={event => { setDescription(event.target.value); resetAttempt(); }} disabled={!!pending} />
                        </label>
                        <fieldset style={{ margin: 0, border: 0, padding: 0 }} disabled={!!pending}>
                            <legend>{t('map:checkIn.rating')}</legend>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                {RATING_TIERS.map(tier => (
                                    <Button key={tier.score} type="button" variant={score === tier.score ? 'primary' : 'secondary'}
                                        aria-pressed={score === tier.score} onClick={() => { setScore(score === tier.score ? null : tier.score); resetAttempt(); }}>
                                        {tierLabel(tier)}
                                    </Button>
                                ))}
                            </div>
                        </fieldset>
                        <div>
                            <Button type="button" variant="secondary" onClick={choosePhotos} disabled={!!pending || photos.length >= PHOTO_LIMIT}>
                                {t('map:checkIn.photos', { count: photos.length })}
                            </Button>
                            {photos.map((photo, index) => <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                                <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{photo.name}</span>
                                <Button type="button" variant="secondary" size="sm" disabled={!!pending}
                                    onClick={() => { setPhotos(current => current.filter((_, item) => item !== index)); resetAttempt(); }}>{t('common:action.remove')}</Button>
                            </div>)}
                        </div>
                    </>
                )}
                {error && <div role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
                {receipt && !retryRating
                    ? <Button type="button" onClick={onClose}>{t('map:checkIn.done')}</Button>
                    : <Button type="submit" disabled={!!pending}>{pending === 'submit' ? t('map:checkIn.submitting')
                        : retryRating ? t('map:checkIn.retryRating') : t('map:checkIn.submit')}</Button>}
            </form>
        </ResponsivePanel>
    );
}
