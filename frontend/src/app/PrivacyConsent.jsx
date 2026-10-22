import React, { useEffect, useRef, useState } from 'react';
import { LegalLink } from '../auth/components/LegalLinks.jsx';
import { readPrivacyConsent, rememberPrivacyChoice } from '../platform/privacyConsent.js';
import { t } from '../i18n/index.js';
import { isNativePlatform } from '../platform/env.js';
import { openExternal } from '../platform/navigation.js';
import './PrivacyConsent.css';

// 业务应用在同意后才动态导入，不把已经启动的地图盖在弹窗下面。
export default function PrivacyConsent({ onAccept }) {
    const [choice, setChoice] = useState(readPrivacyConsent);
    const [attempt, setAttempt] = useState(0);
    const [failed, setFailed] = useState(false);
    const dialogRef = useRef(null);
    const titleRef = useRef(null);

    useEffect(() => {
        if (choice !== 'pending') return;
        const dialog = dialogRef.current;
        // 原生 cancel 事件不依赖 React 的事件委托，确保 Escape/系统关闭请求不能隐藏待选择弹窗。
        const keepOpen = (event) => event.preventDefault();
        dialog.addEventListener('cancel', keepOpen);
        dialog.showModal();
        titleRef.current?.focus();
        return () => dialog.removeEventListener('cancel', keepOpen);
    }, [choice]);

    useEffect(() => {
        if (choice !== 'accepted') return;
        let active = true;
        setFailed(false);
        Promise.resolve().then(onAccept).catch((error) => {
            console.error('应用启动失败', error);
            if (active) setFailed(true);
        });
        return () => { active = false; };
    }, [choice, attempt, onAccept]);

    const choose = (decision) => {
        rememberPrivacyChoice(decision);
        setChoice(decision);
    };

    return (
        <main className="fm-consent-shell">
            <div className="fm-consent-status">
                <p className="fm-consent-brand">{t('common:app.name')}</p>
                {choice === 'rejected' && <>
                    <h1>{t('common:privacy.rejectedTitle')}</h1>
                    <p>{t('common:privacy.rejectedBody')}</p>
                    <LegalLink page="privacy" />
                    <button type="button" className="fm-consent-button" onClick={() => setChoice('pending')}>
                        {t('common:privacy.reconsider')}
                    </button>
                </>}
                {choice === 'accepted' && <>
                    <p role={failed ? 'alert' : 'status'}>{failed ? t('common:privacy.startFailed') : t('common:privacy.starting')}</p>
                    {failed && <button type="button" className="fm-consent-button" onClick={() => setAttempt(value => value + 1)}>
                        {t('common:privacy.retry')}
                    </button>}
                </>}
            </div>
            {choice === 'pending' && <dialog ref={dialogRef} className="fm-consent-dialog"
                aria-labelledby="privacy-consent-title" aria-describedby="privacy-consent-description"
                onCancel={(event) => event.preventDefault()}
                onKeyDown={(event) => { if (event.key === 'Escape') event.preventDefault(); }}>
                <h1 id="privacy-consent-title" ref={titleRef} tabIndex={-1}>{t('common:privacy.title')}</h1>
                <div id="privacy-consent-description">
                    <p>{t('common:privacy.intro')}</p>
                    <p><strong>{t('common:privacy.amap')}</strong></p>
                    <p>{t('common:privacy.permissions')}</p>
                </div>
                <p className="fm-consent-links">
                    <LegalLink page="privacy" />
                    <a href="https://lbs.amap.com/pages/privacy/" target="_blank" rel="noopener noreferrer"
                        onClick={(event) => {
                            if (!isNativePlatform()) return;
                            event.preventDefault();
                            void openExternal(event.currentTarget.href);
                        }}>
                        {t('common:privacy.amapPolicy')}
                    </a>
                </p>
                <p>{t('common:privacy.choiceHint')}</p>
                <div className="fm-consent-actions">
                    <button type="button" className="fm-consent-button" onClick={() => choose('rejected')}>
                        {t('common:privacy.reject')}
                    </button>
                    <button type="button" className="fm-consent-button fm-consent-accept" onClick={() => choose('accepted')}>
                        {t('common:privacy.accept')}
                    </button>
                </div>
            </dialog>}
        </main>
    );
}
