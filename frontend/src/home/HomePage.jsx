import React, { useEffect, useState } from 'react';
import { getApiBaseUrl, getRuntimeConfig } from '../platform/runtimeConfig';
import { t } from '../i18n/index.js';

// 下载页（/home）：扫描海报上的二维码后进入。安卓安装包存在服务器本地（GET /api/app/android/latest.apk），
// iOS 先用 TestFlight 邀请链接，另有“打开网页版”。发版信息来自 GET /api/app/release（backend/modules/appRelease）。
export const IOS_FALLBACK_URL = 'https://testflight.apple.com/join/9wshzYCG';

/** 识别设备：用来把对应的按钮排在前面；微信 / QQ 内置浏览器里下载不了安装包，需要提示换浏览器 */
export function detectDevice(userAgent = '') {
    const ua = String(userAgent);
    const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));
    const android = /Android/i.test(ua);
    const inApp = /MicroMessenger|QQ\/|\bQQ\b|Weibo|DingTalk/i.test(ua);
    return { ios, android, inApp };
}

export default function HomePage() {
    const apiBase = getApiBaseUrl();
    const { icpBeian } = getRuntimeConfig();
    const [release, setRelease] = useState(null);
    const device = detectDevice(typeof navigator === 'undefined' ? '' : navigator.userAgent);

    useEffect(() => {
        const controller = new AbortController();
        fetch(`${apiBase}/api/app/release`, { signal: controller.signal, cache: 'no-cache' })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => { if (data) setRelease(data); })
            .catch(() => { });
        return () => controller.abort();
    }, [apiBase]);

    const android = release?.android || null;
    const ios = release?.ios || null;
    // 读不到发版信息时也给下载链接：服务器没有安装包时那边返回 404 说明
    const androidAvailable = android ? android.available !== false : true;
    const iosUrl = ios?.url || IOS_FALLBACK_URL;

    const buttons = [
        {
            id: 'android',
            icon: 'android',
            title: t('home:android.title'),
            detail: android?.version ? t('home:version', { version: android.version }) : t('home:android.detail'),
            href: androidAvailable ? `${apiBase}/api/app/android/latest.apk` : null,
            disabledText: t('home:android.unavailable'),
            download: true
        },
        {
            id: 'ios',
            icon: 'phone_iphone',
            title: t('home:ios.title'),
            detail: ios?.version ? t('home:version', { version: ios.version }) : t('home:ios.detail'),
            href: iosUrl
        },
        {
            id: 'web',
            icon: 'public',
            title: t('home:web.title'),
            detail: t('home:web.detail'),
            href: '/'
        }
    ];
    // 当前设备对应的按钮排在最前
    const preferred = device.ios ? 'ios' : (device.android ? 'android' : 'web');
    buttons.sort((a, b) => (b.id === preferred) - (a.id === preferred));

    return (
        <div className="home">
            <main className="home__card">
                <section className="home__intro">
                    <img className="home__logo" src="/logo.png" alt="" width="96" height="96" />
                    <p className="home__eyebrow">{t('home:eyebrow')}</p>
                    <h1 className="home__title">{t('home:title')}</h1>
                    <p className="home__lead">{t('home:lead')}</p>
                </section>
                <section className="home__actions" aria-label={t('home:actionsLabel')}>
                    {device.inApp && <p className="home__notice" role="note">{t('home:inAppNotice')}</p>}
                    {buttons.map((button) => {
                        const content = (
                            <>
                                <span className="material-symbols-outlined home__icon" aria-hidden="true">{button.icon}</span>
                                <span className="home__button-text">
                                    <span className="home__button-title">{button.title}</span>
                                    <span className="home__button-detail">{button.href ? button.detail : button.disabledText}</span>
                                </span>
                            </>
                        );
                        const className = `home__button${button.id === preferred ? ' home__button--primary' : ''}`;
                        return button.href ? (
                            <a key={button.id} className={className} href={button.href}
                                {...(button.download ? { download: '' } : null)}
                                {...(button.id === 'ios' ? { target: '_blank', rel: 'noopener noreferrer' } : null)}>
                                {content}
                            </a>
                        ) : (
                            <span key={button.id} className={`${className} home__button--disabled`} aria-disabled="true">{content}</span>
                        );
                    })}
                    {android?.notes && preferred === 'android' && <p className="home__notes">{android.notes}</p>}
                    {ios?.notes && preferred === 'ios' && <p className="home__notes">{ios.notes}</p>}
                </section>
            </main>
            <footer className="home__footer">
                <span>{t('home:footer')}</span>
                {icpBeian && <a href={icpBeian.url} target="_blank" rel="noopener noreferrer">{icpBeian.text}</a>}
            </footer>
        </div>
    );
}
