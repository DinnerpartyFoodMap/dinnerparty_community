// 测试替身：@capacitor/core 照常导出（其他插件要 WebPlugin 等），只有 registerPlugin 换成页面里的假原生插件
// （native-admin-venues-harness.jsx）。用真实文件路径引入，避开指向本文件的别名。
export * from '../../../node_modules/@capacitor/core/dist/index.js';

export function registerPlugin() {
    return window.__fakeNativeAdmin;
}
