// 原生页面引擎（NativePageEngine.swift，管理后台与日记 · 同好共用）里原生自己显示的几句文案：
// 随页面模型的 labels 下发，原生只在旧网页没有下发时用中文兜底。
import { t } from '../i18n/index.js';

export function nativePageLabels() {
    return {
        cancel: t('common:action.cancel'),
        ok: t('common:action.ok'),
        timeout: t('common:error.timeout'),
        pickImage: t('common:action.chooseImage'),
        removeImage: t('common:action.remove')
    };
}
