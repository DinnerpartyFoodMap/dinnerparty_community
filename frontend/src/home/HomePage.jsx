import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getApiBaseUrl, getRuntimeConfig } from '../platform/runtimeConfig';
import { t } from '../i18n/index.js';

export const IOS_FALLBACK_URL = 'https://apps.apple.com/app/id6823438886';

/** 公开主页只使用正式商店入口，兼容旧服务器仍返回 TestFlight 链接的情况。 */
export function getIosDownloadUrl(value) {
    return typeof value === 'string' && /^https:\/\/apps\.apple\.com\//i.test(value) ? value : IOS_FALLBACK_URL;
}

/** 按设备排列下载入口，并识别需要切换浏览器的应用内 WebView。 */
export function detectDevice(userAgent = '') {
    const ua = String(userAgent);
    const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));
    const android = /Android/i.test(ua);
    const inApp = /MicroMessenger|QQ\/|\bQQ\b|Weibo|DingTalk/i.test(ua);
    return { ios, android, inApp };
}

/** 默认正文可见；允许动效且观察器可用时才启用入场，滚动仅播放一次。 */
function useReveal() {
    const root = useRef(null);
    useLayoutEffect(() => {
        const element = root.current;
        if (!element || !window.matchMedia || !window.IntersectionObserver) return;
        const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
        let observer;
        const configure = () => {
            observer?.disconnect();
            element.classList.remove('home--motion');
            if (preference.matches) return;
            observer = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    entry.target.setAttribute('data-revealed', '');
                    observer.unobserve(entry.target);
                });
            }, { threshold: 0.12 });
            element.classList.add('home--motion');
            element.querySelectorAll('[data-reveal]').forEach((item) => observer.observe(item));
        };
        configure();
        preference.addEventListener('change', configure);
        return () => {
            observer?.disconnect();
            preference.removeEventListener('change', configure);
            element.classList.remove('home--motion');
        };
    }, []);
    return root;
}

function RevealLine({ children, className = '', delay = 0 }) {
    return <span className={`home__line ${className}`} data-reveal style={{ '--reveal-delay': `${delay}ms` }}><span>{children}</span></span>;
}

/** 首屏与下载区复用链接行为，确保平台目标、下载属性和不可用状态一致。 */
function PlatformLink({ button, className, children, ...props }) {
    if (!button.href) {
        return <span className={`${className} home__link--disabled`} role="link" aria-disabled="true" {...props}>{children}</span>;
    }
    return (
        <a className={className} href={button.href} {...props}
            {...(button.download ? { download: '' } : null)}
            {...(button.id === 'ios' ? { target: '_blank', rel: 'noopener noreferrer' } : null)}>
            {children}
        </a>
    );
}

export function DownloadCard({ button, preferred, index }) {
    const className = `home__button${button.id === preferred ? ' home__button--primary' : ''}`;
    return (
        // 动效观察稳定的外层；发版响应让内部 a/span 切换时，不会丢失观察目标。
        <div className="home__download-card" data-reveal style={{ '--reveal-delay': `${index * 90}ms` }}>
            <PlatformLink button={button} className={className}>
                <span className="home__button-top"><span className="material-symbols-outlined home__icon" aria-hidden="true">{button.icon}</span><span>{button.label}</span></span>
                <span className="home__button-text"><span className="home__button-title">{button.title}</span><span className="home__button-detail">{button.href ? button.detail : button.disabledText}</span></span>
            </PlatformLink>
        </div>
    );
}

export default function HomePage() {
    const root = useReveal();
    const apiBase = getApiBaseUrl();
    const { icpBeian, gonganBeian } = getRuntimeConfig();
    const [release, setRelease] = useState(null);
    const device = detectDevice(typeof navigator === 'undefined' ? '' : navigator.userAgent);

    useEffect(() => {
        const controller = new AbortController();
        fetch(`${apiBase}/api/app/release`, { signal: controller.signal, cache: 'no-cache' })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => { if (data && !controller.signal.aborted) setRelease(data); })
            .catch(() => {});
        return () => controller.abort();
    }, [apiBase]);

    const android = release?.android || null;
    const ios = release?.ios || null;
    const androidAvailable = android ? android.available !== false : true;
    const preferred = device.ios ? 'ios' : (device.android ? 'android' : 'web');
    const buttons = [
        {
            id: 'android', icon: 'android', label: 'ANDROID', title: t('home:android.title'),
            detail: android?.version ? t('home:version', { version: android.version }) : t('home:android.detail'),
            href: androidAvailable ? `${apiBase}/api/app/android/latest.apk` : null,
            disabledText: t('home:android.unavailable'), download: true
        },
        {
            id: 'ios', icon: 'phone_iphone', label: 'iOS', title: t('home:ios.title'),
            detail: ios?.version ? t('home:ios.version', { version: ios.version }) : t('home:ios.detail'),
            href: getIosDownloadUrl(ios?.url)
        },
        { id: 'web', icon: 'public', label: 'WEB', title: t('home:web.title'), detail: t('home:web.detail'), href: '/' }
    ];
    buttons.sort((a, b) => (b.id === preferred) - (a.id === preferred));
    const primaryButton = buttons[0];
    const features = [
        { icon: 'travel_explore', label: 'DISCOVER', title: t('home:features.discover.title'), body: t('home:features.discover.body') },
        { icon: 'add_location_alt', label: 'CONTRIBUTE', title: t('home:features.contribute.title'), body: t('home:features.contribute.body') },
        { icon: 'rate_review', label: 'CONNECT', title: t('home:features.connect.title'), body: t('home:features.connect.body') }
    ];

    return (
        <div className="home" ref={root}>
            <a className="home__skip" href="#main">{t('home:skipLink')}</a>
            <header className="home__header home__container">
                <a className="home__brand" href="/home/" aria-label={t('home:title')}>
                    <img src="/favicon.png" alt="" width="40" height="40" />
                    <span>{t('home:title')}<span className="home__brand-en">DINNERPARTY FOOD MAP</span></span>
                </a>
                <nav className="home__nav" aria-label={t('home:nav.label')}>
                    <a className="home__nav-about" href="#explore">{t('home:nav.explore')}</a>
                    <a href="#download">{t('home:nav.download')}</a>
                    <a className="home__nav-web" href="/">{t('home:nav.web')}<span className="material-symbols-outlined" aria-hidden="true">public</span></a>
                </nav>
            </header>
            <main id="main">
                <section className="home__hero home__container" aria-labelledby="hero-title">
                    <div className="home__hero-panel">
                        <div className="home__hero-copy">
                            <p className="home__eyebrow" data-reveal><span className="home__small-square" />{t('home:eyebrow')}</p>
                            <h1 id="hero-title" className="home__title"><RevealLine>{t('home:hero.lineOne')}</RevealLine><RevealLine className="home__accent" delay={110}>{t('home:hero.lineTwo')}</RevealLine></h1>
                            <p className="home__lead" data-reveal style={{ '--reveal-delay': '220ms' }}>{t('home:lead')}</p>
                            <div className="home__hero-actions" data-reveal style={{ '--reveal-delay': '300ms' }}>
                                <PlatformLink button={primaryButton} className="home__cta">
                                    {primaryButton.href ? primaryButton.title : primaryButton.disabledText}
                                    <span className="material-symbols-outlined" aria-hidden="true">{primaryButton.icon}</span>
                                </PlatformLink>
                                <a className="home__text-link" href={preferred === 'web' ? '#download' : '/'}>
                                    {preferred === 'web' ? t('home:hero.download') : t('home:web.title')}
                                </a>
                            </div>
                            {device.inApp && <p className="home__notice home__hero-notice" role="note">{t('home:inAppNotice')}</p>}
                        </div>
                    </div>
                </section>
                <section id="explore" className="home__explore home__container" aria-labelledby="explore-title">
                    <div className="home__section-heading">
                        <p className="home__eyebrow" data-reveal>{t('home:explore.eyebrow')}</p>
                        <h2 id="explore-title" className="home__section-title"><RevealLine>{t('home:explore.title')}</RevealLine></h2>
                        <p className="home__section-description" data-reveal>{t('home:explore.body')}</p>
                    </div>
                    <div className="home__features">{features.map((feature, index) => (
                        <article className="home__feature" key={feature.label} data-reveal style={{ '--reveal-delay': `${index * 90}ms` }}>
                            <div className="home__feature-top"><span>{feature.label}</span><span className="material-symbols-outlined" aria-hidden="true">{feature.icon}</span></div>
                            <h3>{feature.title}</h3><p>{feature.body}</p>
                        </article>
                    ))}</div>
                </section>
                <section className="home__manifesto" aria-labelledby="manifesto-title">
                    <div className="home__container home__manifesto-inner">
                        <div className="home__manifesto-aside" data-reveal><span className="home__asterisk" aria-hidden="true">✳</span><span>{t('home:manifesto.eyebrow')}</span></div>
                        <h2 id="manifesto-title"><RevealLine>{t('home:manifesto.lineOne')}</RevealLine><RevealLine delay={100}>{t('home:manifesto.lineTwo')}</RevealLine></h2>
                        <p data-reveal>{t('home:manifesto.body')}</p>
                    </div>
                </section>
                <section id="download" className="home__download home__container" aria-labelledby="download-title">
                    <div className="home__section-heading">
                        <p className="home__eyebrow" data-reveal>{t('home:download.eyebrow')}</p>
                        <h2 id="download-title" className="home__section-title"><RevealLine>{t('home:download.title')}</RevealLine></h2>
                    </div>
                    <div className="home__actions" aria-label={t('home:actionsLabel')}>
                        {buttons.map((button, index) => <DownloadCard key={button.id} button={button} preferred={preferred} index={index} />)}
                    </div>
                    {android?.notes && preferred === 'android' && <p className="home__notes">{android.notes}</p>}
                    {ios?.notes && preferred === 'ios' && <p className="home__notes">{ios.notes}</p>}
                </section>
            </main>
            <footer className="home__footer home__container">
                <div className="home__footer-main"><a className="home__footer-brand" href="/home/">{t('home:title')}</a><p>{t('home:footerTagline')}</p><a className="home__back-top" href="#main">{t('home:backToTop')}</a></div>
                <div className="home__footer-meta"><span>{t('home:footer')}</span><div className="home__footer-links"><a href="/privacy/">{t('home:legal.privacy')}</a><a href="/terms/">{t('home:legal.terms')}</a><a href="/support/">{t('home:legal.support')}</a></div></div>
                {(icpBeian || gonganBeian) && <div className="home__filing">{[icpBeian, gonganBeian].filter(Boolean).map((filing) => <a key={filing.url} href={filing.url} target="_blank" rel="noopener noreferrer">{filing.text}</a>)}</div>}
            </footer>
        </div>
    );
}
