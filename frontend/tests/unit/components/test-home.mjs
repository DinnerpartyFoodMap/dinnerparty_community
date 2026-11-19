import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// 通过真实组件检查可用状态切换的 DOM 契约；不监听端口，不请求真实发版服务。
const server = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { disabled: true } });
try {
    const { DownloadCard, IOS_FALLBACK_URL, getIosDownloadUrl, detectDevice } = await server.ssrLoadModule('/src/home/HomePage.jsx');
    const android = {
        id: 'android', icon: 'android', label: 'ANDROID', title: '下载 Android 版',
        detail: '安装包直接下载', disabledText: '安装包暂未上传',
        href: '/api/app/android/latest.apk', download: true
    };
    const render = (button, preferred = 'android') => renderToStaticMarkup(React.createElement(DownloadCard, { button, preferred, index: 1 }));
    const available = render(android);
    const unavailable = render({ ...android, href: null });

    // 两种状态的外层标签及动效属性相同，内部 a/span 变化不会替换观察节点。
    const outer = (html) => html.slice(0, html.indexOf('>') + 1);
    assert.match(outer(available), /^<div class="home__download-card" data-reveal=/);
    assert.equal(outer(available), outer(unavailable));
    for (const html of [available, unavailable]) {
        assert.equal((html.match(/data-reveal=/g) || []).length, 1, 'only the persistent wrapper is observed');
        assert.ok(html.includes(android.title), 'Android title remains present');
        assert.ok(html.includes('home__button--primary'), 'current platform stays emphasized');
    }
    assert.ok(available.includes('href="/api/app/android/latest.apk"') && available.includes('download=""'));
    assert.ok(unavailable.includes('aria-disabled="true"') && unavailable.includes(android.disabledText));
    assert.ok(!unavailable.includes('<a '), 'unavailable APK has no actionable link');
    assert.ok(!render(android, 'web').includes('home__button--primary'), 'other platforms do not override desktop emphasis');

    const ios = { id: 'ios', icon: 'phone_iphone', label: 'iOS', title: '下载 iOS 版', detail: '在 App Store 下载', href: getIosDownloadUrl() };
    const iosHtml = render(ios, 'ios');
    assert.ok(iosHtml.includes(`href="${IOS_FALLBACK_URL}"`) && iosHtml.includes('App Store'));
    assert.ok(iosHtml.includes('target="_blank"') && iosHtml.includes('rel="noopener noreferrer"'));
    const regionalStore = 'https://apps.apple.com/cn/app/id6823438886';
    assert.equal(getIosDownloadUrl(regionalStore), regionalStore);
    for (const url of [undefined, '', 'https://testflight.apple.com/join/old', 'https://example.com/app', 'https://apps.apple.com.example.com/app', 'http://apps.apple.com/app/id6823438886']) {
        assert.equal(getIosDownloadUrl(url), IOS_FALLBACK_URL, 'old beta or invalid links use the public App Store entry');
    }
    const require = createRequire(import.meta.url);
    const { platformRelease } = require('../../../../backend/modules/appRelease/services/appRelease.js');
    assert.equal(platformRelease('ios', {}).url, IOS_FALLBACK_URL, 'backend default matches the public homepage');
    assert.equal(detectDevice('Mozilla/5.0 (Linux; Android 15)').android, true);
    assert.equal(detectDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)').ios, true);
    console.log('Home download passed: persistent reveal wrapper, visible unavailable Android state, platform emphasis, APK attributes and App Store fallback.');
} finally {
    await server.close();
}
