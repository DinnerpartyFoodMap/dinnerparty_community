import React, { useEffect, useState } from 'react';
import { fetchProfileFavorites } from '../api/client';
import { t } from '../i18n/index.js';
import { PlaceRow, ProfileShell } from './UserProfilePage';

export default function ProfileFavoritesPage({ backendUrl, token, userId, currentUser, onOpenPlace, onBack }) {
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const self = currentUser && String(currentUser.id) === String(userId);

    useEffect(() => {
        const controller = new AbortController();
        setResult(null);
        setError('');
        fetchProfileFavorites(backendUrl, userId, { token, signal: controller.signal }).then((data) => {
            if (!controller.signal.aborted) setResult(data);
        }).catch((failure) => {
            if (!controller.signal.aborted) setError(failure.message);
        });
        return () => controller.abort();
    }, [backendUrl, token, userId]);

    return <ProfileShell onBack={onBack} title={self ? t('profile:widgets.collection.mine') : t('profile:widgets.collection.title')}>
        {error ? <p className="fm-profile__message" role="alert">{error}</p>
            : !result ? <p className="fm-profile__message" role="status">{t('common:status.loading')}</p>
                : result.places.length ? <section className="fm-profile__widget"><PlaceRow places={result.places} onOpenPlace={onOpenPlace} grid /></section>
                    : <p className="fm-profile__message">{t('profile:widgets.collection.empty')}</p>}
    </ProfileShell>;
}
