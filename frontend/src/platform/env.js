// 运行环境识别：只在平台层内部使用，业务组件通过能力接口调用，不直接判断平台。
// Capacitor 原生壳会在页面脚本执行前注入 window.Capacitor，因此这里无需引入 @capacitor/core，
// 网页构建不会因为平台识别而加载原生桥代码。

export function getCapacitor() {
    return typeof window !== 'undefined' ? window.Capacitor : undefined;
}

export function isNativePlatform() {
    const cap = getCapacitor();
    try {
        return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    } catch (e) {
        return false;
    }
}

/** @returns {'web'|'ios'|'android'} */
export function getPlatform() {
    if (!isNativePlatform()) return 'web';
    try {
        const platform = getCapacitor().getPlatform();
        return platform === 'ios' || platform === 'android' ? platform : 'web';
    } catch (e) {
        return 'web';
    }
}

export function isPluginAvailable(name) {
    const cap = getCapacitor();
    try {
        return !!(cap && typeof cap.isPluginAvailable === 'function' && cap.isPluginAvailable(name));
    } catch (e) {
        return false;
    }
}

/** 构建时注入的前端版本号（见 vite.config.js），用于诊断和会话记录。 */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export function getClientInfo() {
    return { platform: getPlatform(), app_version: APP_VERSION };
}
