import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

function isLocalHostname(hostname) {
    return /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i.test(hostname || '');
}

// 移动正式构建缺少 HTTPS 服务地址时明确失败，不在运行时猜测本地后端地址。
function assertMobileEnv(env) {
    const errors = [];
    for (const name of ['VITE_BACKEND_URL', 'VITE_PUBLIC_WEB_URL']) {
        const value = String(env[name] || '').trim();
        if (!value) {
            errors.push(`${name} 未配置`);
            continue;
        }
        let url;
        try {
            url = new URL(value);
        } catch (e) {
            errors.push(`${name} 不是有效的 URL：${value}`);
            continue;
        }
        if (url.protocol !== 'https:') errors.push(`${name} 必须使用 HTTPS：${value}`);
        if (isLocalHostname(url.hostname)) errors.push(`${name} 不能指向本机地址：${value}`);
    }
    if (errors.length) {
        throw new Error(`移动应用构建配置错误（见 frontend/.env.mobile）：\n  - ${errors.join('\n  - ')}`);
    }
}

// App 内优先使用随包携带的图标字体，避免首屏依赖外部 CDN
function bundledIconFont() {
    return {
        name: 'yuyuko-bundled-icon-font',
        transformIndexHtml(html) {
            return html.replace('https://cdn.mccolor.cc/fonts/material-symbols.css', '/fonts/material-symbols.css');
        }
    };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, __dirname, 'VITE_');
    const isMobile = mode === 'mobile' || env.VITE_TARGET === 'native';
    if (isMobile) assertMobileEnv(env);

    // 构建号由 CI 传入（APP_BUILD_NUMBER），用于诊断与会话记录中的客户端版本
    const buildNumber = String(process.env.APP_BUILD_NUMBER || '').trim();
    const appVersion = buildNumber ? `${pkg.version} (${buildNumber})` : pkg.version;

    return {
        define: {
            __APP_VERSION__: JSON.stringify(appVersion)
        },
        plugins: isMobile ? [bundledIconFont()] : [],
        build: {
            rollupOptions: {
                // motion 包内的 "use client" 指令对客户端打包无意义，Rollup 会逐个文件告警
                onwarn(warning, warn) {
                    if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && /use client/.test(warning.message)) return;
                    warn(warning);
                },
                input: {
                    main: resolve(__dirname, 'index.html'),
                    beian: resolve(__dirname, 'beian/index.html')
                }
            }
        }
    };
});
