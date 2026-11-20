// 同好与角色观察屋：网页同好页（ProfileCommunityPage）与 iOS 原生住民主页的二级页（NativeProfilePlugin.swift）共用的数据整理。
// 原生不访问后端：网页取同好、发现设置与小伙伴状态，整理成可以直接显示的文案、头像地址与星图坐标。
import { resolveAvatarUrl } from '../auth/avatarUrl.js';
import { DEFAULT_COMPANION, DEFAULT_COMPANION_PREVIEW } from '../companion/defaultCompanion.js';
import { t } from '../i18n/index.js';

/** 星图坐标的范围：后端 x、y 落在半径 0.95 的圆内，画布取 [-1.2, 1.2] 留出头像的位置 */
export const COMMUNITY_MAP_EXTENT = 1.2;
const TAG_LIMIT = 20;

export function neighborMeta(person) {
    const shared = Array.isArray(person?.shared) ? person.shared : [];
    return t('journey:community.neighborMeta', {
        similarity: Math.round((Number(person?.similarity) || 0) * 100),
        confidence: person?.confidence || '',
        value: shared.length ? ` · ${shared.join(' · ')}` : ''
    });
}

/** 没有同好时的说明；disabled 时带“前往发现设置” */
export function communityEmptyState(data) {
    if (data?.profile_status === 'disabled') {
        return { title: t('journey:community.empty.disabledTitle'), hint: t('journey:community.empty.disabledHint'), action: 'settings', actionLabel: t('journey:community.empty.goToSettings') };
    }
    if (data?.profile_status === 'ready') return { title: t('journey:community.empty.noMatchTitle'), hint: t('journey:community.empty.noMatchHint'), action: '', actionLabel: '' };
    return { title: t('journey:community.empty.notEnoughTitle'), hint: t('journey:community.empty.notEnoughHint'), action: '', actionLabel: '' };
}

const clampCoordinate = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(-1, Math.min(1, number)) : 0;
};

/** GET /api/community/neighbors 的结果 → 列表与星图共用的行（最多 20 人，不分页） */
export function buildCommunityPeople(data, { backendUrl } = {}) {
    const list = Array.isArray(data?.neighbors) ? data.neighbors : [];
    return list.slice(0, 20).map((person) => {
        const name = String(person.username || '');
        return {
            id: String(person.id),
            name,
            // 没有头像时由服务器返回默认头像（原生只接受 https 地址）
            avatarURL: resolveAvatarUrl(person, backendUrl, { serverFallback: true }),
            meta: neighborMeta(person),
            x: clampCoordinate(person.x),
            y: clampCoordinate(person.y),
            accessible: t('profile:community.openProfile', { name })
        };
    });
}

export function buildCommunitySettings(consent, stats) {
    if (!consent) return null;
    return {
        discovery: !!consent.discovery,
        feedback: !!consent.feedback,
        research: !!consent.research,
        tags: (Array.isArray(consent.tags) ? consent.tags : []).join(t('journey:community.tagSeparator')),
        hint: t('journey:community.settingsHint'),
        retention: t('journey:community.retentionHint', { days: stats?.retention_days || consent.retention_days || 90 })
    };
}

/** 原生同好页的文案（Swift 只在旧网页包没有下发时用中文兜底） */
export function communityLabels() {
    return {
        title: t('journey:common.feature.community'),
        tabsLabel: t('journey:community.tabsLabel'),
        tabNeighbors: t('journey:common.feature.community'),
        tabSettings: t('journey:community.tab.settings'),
        viewModeLabel: t('journey:community.viewModeLabel'),
        viewList: t('journey:community.viewMode.list'),
        viewMap: t('journey:community.viewMode.map'),
        mapLabel: t('journey:community.mapLabel'),
        me: t('journey:community.me'),
        tagsLabel: t('journey:community.tagsLabel'),
        discovery: t('journey:community.consent.discovery'),
        feedback: t('journey:community.consent.feedback'),
        research: t('journey:community.consent.research'),
        saveSettings: t('journey:community.saveSettings'),
        clearInteractions: t('journey:community.clearInteractions'),
        loading: t('common:status.loading'),
        retry: t('profile:retry'),
        ok: t('common:action.ok'),
        back: t('common:action.back')
    };
}

/** 兴趣标签输入框（中英文逗号分隔）→ 后端的标签数组 */
export function parseCommunityTags(text) {
    return String(text || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, TAG_LIMIT);
}

/**
 * 原生同好页的请求：读取同好、发现设置，保存设置，清除交互记录。返回值直接回传原生（community 对象）。
 * getToken / getUser 每次取最新值；request 与 publishMapConsent 由调用方传入（journey/feedback.jsx），
 * 保存设置后通知地图，与网页同好页相同。
 */
export function createCommunityController({ backendUrl, getToken, getUser, request, publishMapConsent }) {
    const api = (path, options) => request(backendUrl, getToken(), `/api/community${path}`, options);
    let consent = null;
    const me = () => ({ avatarURL: resolveAvatarUrl(getUser?.(), backendUrl, { serverFallback: true }) || '', label: t('journey:community.me') });
    const neighbors = async () => {
        try {
            const data = await api('/neighbors');
            const people = buildCommunityPeople(data, { backendUrl });
            return { status: 'ready', error: '', people, empty: people.length ? null : communityEmptyState(data) };
        } catch (error) {
            return { status: 'error', error: String(error?.message || t('profile:loadFailed')).slice(0, 200), people: [], empty: null };
        }
    };
    const settings = async () => {
        const [current, stats] = await Promise.all([api('/consent'), api('/feedback')]);
        consent = current;
        return buildCommunitySettings(current, stats);
    };
    return {
        async load() {
            return { labels: communityLabels(), me: me(), neighbors: await neighbors() };
        },
        async loadSettings() {
            return { settings: await settings() };
        },
        async save(values) {
            const base = consent || await api('/consent');
            const next = {
                ...base,
                discovery: !!values.discovery,
                feedback: !!values.feedback,
                research: !!values.feedback && !!values.research,
                tags: parseCommunityTags(values.tags),
                research_choice: !!values.researchChoice
            };
            const saved = await api('/consent', { method: 'PUT', body: JSON.stringify(next) });
            consent = saved;
            publishMapConsent(getToken(), saved);
            const stats = await api('/feedback');
            return { settings: buildCommunitySettings(saved, stats), neighbors: await neighbors(), notice: t('journey:community.settingsSaved') };
        },
        async clear() {
            const cleared = await api('/feedback', { method: 'DELETE' });
            consent = cleared;
            publishMapConsent(getToken(), cleared);
            const stats = await api('/feedback');
            return { settings: buildCommunitySettings(cleared, stats), notice: t('journey:community.interactionsCleared') };
        }
    };
}

/**
 * 原生角色观察屋：开关、当前角色、饱食度与可切换的角色。额外角色的模型是私有资源包，原生只显示名字，
 * 预览为空时 Swift 用图标代替（Live2D 动画仍只在网页与地图底栏）。
 */
export function buildCompanionViewModel(companion, { enabled = true } = {}) {
    const state = companion || {};
    const owned = Array.isArray(state.owned) ? state.owned : [];
    const roles = [{ id: DEFAULT_COMPANION, name: t('companion:defaultName') },
        ...owned.filter((role) => role && role.id).map((role) => ({ id: String(role.id), name: String(role.name || role.id) }))];
    const active = roles.find((role) => role.id === state.active) || roles[0];
    const satiety = Math.max(0, Number.parseInt(state.satiety, 10) || 0);
    const isDefault = active.id === DEFAULT_COMPANION;
    return {
        enabled: !!enabled,
        active: active.id,
        name: active.name,
        roles,
        satietyCount: satiety,
        satiety: t('companion:satiety', { count: satiety }),
        hint: t('companion:unlockHint'),
        preview: isDefault ? DEFAULT_COMPANION_PREVIEW : '',
        labels: {
            title: t('companion:title'),
            enabled: t('companion:enabled'),
            role: t('companion:role'),
            fed: t('companion:fed'),
            switchFailed: t('companion:switchFailed'),
            saveFailed: t('settings:personalizeMap.saveFailed'),
            loading: t('common:status.loading'),
            retry: t('profile:retry'),
            ok: t('common:action.ok')
        }
    };
}
