// 测试预期直接读取固定语言的 JSON，不依赖应用的 i18n 初始化或 Node JSON loader。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import i18next from 'i18next';

const locales = new URL('../../src/i18n/locales/zh-CN/', import.meta.url);
const resources = Object.fromEntries(readdirSync(locales)
    .filter(file => file.endsWith('.json'))
    .map(file => [file.slice(0, -5), JSON.parse(readFileSync(new URL(file, locales), 'utf8'))]));
const i18n = i18next.createInstance();
i18n.init({
    resources: { 'zh-CN': resources },
    lng: 'zh-CN',
    fallbackLng: false,
    ns: Object.keys(resources),
    interpolation: { escapeValue: false },
    initAsync: false
});

export function localeText(key, values = {}) {
    assert.ok(i18n.exists(key), `Missing zh-CN test translation: ${key}`);
    const text = i18n.t(key, { ...values, returnObjects: true });
    assert.equal(typeof text, 'string', `Test translation must be text: ${key}`);
    assert.doesNotMatch(text, /\{\{[^{}]+\}\}/, `Missing test interpolation: ${key}`);
    return text;
}
