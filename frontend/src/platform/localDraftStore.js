// 行程草稿本地落盘：编辑后立即保存到设备，按账号隔离，记录服务器草稿标识、版本与待同步状态。
// 网页与 App（WKWebView / Android WebView）都使用 IndexedDB；不可用时退回 localStorage。
// 本地记录只是“未同步编辑”的保险，真正的保存仍走服务端 revision / 冲突协议。

const DB_NAME = 'yuyuko-local-drafts';
const STORE = 'journey-drafts';
const DB_VERSION = 1;
const LS_PREFIX = 'yuyuko.localDraft.v1:';

let dbPromise = null;

function openDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!dbPromise) {
        dbPromise = new Promise((resolve) => {
            let request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) {
                resolve(null);
                return;
            }
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'key' });
                    store.createIndex('userId', 'userId', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        });
    }
    return dbPromise;
}

function tx(db, mode, run) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        let result;
        Promise.resolve(run(store)).then((value) => { result = value; });
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

function req(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const recordKey = (userId, slot) => `${userId}:${slot}`;

/**
 * 保存（覆盖）一条本地草稿记录。
 * @param {string} userId
 * @param {string} slot 草稿槽位，当前编辑器使用 'active'
 * @param {{journal: object, serverDraftId?: string|null, serverRevision?: number, synced: boolean}} data
 */
export async function saveLocalDraft(userId, slot, data) {
    if (!userId) return false;
    const record = {
        key: recordKey(userId, slot),
        userId,
        slot,
        journal: data.journal,
        serverDraftId: data.serverDraftId || null,
        serverRevision: Number.isFinite(data.serverRevision) ? data.serverRevision : 0,
        synced: !!data.synced,
        updatedAt: Date.now()
    };
    const db = await openDb();
    if (db) {
        try {
            await tx(db, 'readwrite', (store) => req(store.put(record)));
            return true;
        } catch (e) { /* 退回 localStorage */ }
    }
    try {
        localStorage.setItem(LS_PREFIX + record.key, JSON.stringify(record));
        return true;
    } catch (e) {
        return false;
    }
}

export async function loadLocalDraft(userId, slot) {
    if (!userId) return null;
    const key = recordKey(userId, slot);
    const db = await openDb();
    if (db) {
        try {
            const record = await tx(db, 'readonly', (store) => req(store.get(key)));
            if (record) return record;
        } catch (e) { /* 继续尝试 localStorage */ }
    }
    try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

export async function deleteLocalDraft(userId, slot) {
    if (!userId) return;
    const key = recordKey(userId, slot);
    const db = await openDb();
    if (db) {
        try { await tx(db, 'readwrite', (store) => req(store.delete(key))); } catch (e) { /* ignore */ }
    }
    try { localStorage.removeItem(LS_PREFIX + key); } catch (e) { /* ignore */ }
}

/** 删除某账号的全部本地草稿（账号注销时调用）。 */
export async function clearLocalDraftsForUser(userId) {
    if (!userId) return;
    const db = await openDb();
    if (db) {
        try {
            await tx(db, 'readwrite', async (store) => {
                const keys = await req(store.index('userId').getAllKeys(userId));
                await Promise.all(keys.map((key) => req(store.delete(key))));
            });
        } catch (e) { /* ignore */ }
    }
    try {
        Object.keys(localStorage)
            .filter((key) => key.startsWith(`${LS_PREFIX}${userId}:`))
            .forEach((key) => localStorage.removeItem(key));
    } catch (e) { /* ignore */ }
}

// ---- 图文生成的素材草稿：每份按账号与草稿 ID 单独存放，不占用编辑器的 active 槽位 ----
// 记录中可以包含尚未上传的图片 Blob（IndexedDB 支持结构化克隆）；退回 localStorage 时 Blob 无法保存，
// 返回值会说明哪些内容没有落盘，供页面如实提示。

const COMPOSE_PREFIX = 'compose:';

/**
 * @param {string} userId
 * @param {string} draftId
 * @param {{payload: object, photos: Array<{key:string, mediaId?:string|null, blob?:Blob|null, name?:string}>, serverRevision: number, synced: boolean}} data
 * @returns {Promise<{saved: boolean, blobs: boolean}>}
 */
export async function saveLocalCompose(userId, draftId, data) {
    if (!userId || !draftId) return { saved: false, blobs: false };
    const record = {
        key: recordKey(userId, COMPOSE_PREFIX + draftId),
        userId,
        slot: COMPOSE_PREFIX + draftId,
        draftId,
        payload: data.payload,
        photos: data.photos || [],
        serverRevision: Number.isFinite(data.serverRevision) ? data.serverRevision : 0,
        synced: !!data.synced,
        updatedAt: Date.now()
    };
    const db = await openDb();
    if (db) {
        try {
            await tx(db, 'readwrite', (store) => req(store.put(record)));
            return { saved: true, blobs: true };
        } catch (e) { /* 退回 localStorage */ }
    }
    try {
        const pendingBlobs = record.photos.some((photo) => photo.blob);
        const light = { ...record, photos: record.photos.map(({ blob, ...photo }) => photo) };
        localStorage.setItem(LS_PREFIX + record.key, JSON.stringify(light));
        return { saved: true, blobs: !pendingBlobs };
    } catch (e) {
        return { saved: false, blobs: false };
    }
}

export async function loadLocalCompose(userId, draftId) {
    if (!userId || !draftId) return null;
    const key = recordKey(userId, COMPOSE_PREFIX + draftId);
    const db = await openDb();
    if (db) {
        try {
            const record = await tx(db, 'readonly', (store) => req(store.get(key)));
            if (record) return record;
        } catch (e) { /* 继续尝试 localStorage */ }
    }
    try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

/** 列出某账号所有本机素材草稿记录（含尚未同步到服务器的）。 */
export async function listLocalComposes(userId) {
    if (!userId) return [];
    const records = new Map();
    const db = await openDb();
    if (db) {
        try {
            const all = await tx(db, 'readonly', (store) => req(store.index('userId').getAll(userId)));
            for (const record of all || []) if (String(record.slot || '').startsWith(COMPOSE_PREFIX)) records.set(record.key, record);
        } catch (e) { /* ignore */ }
    }
    try {
        Object.keys(localStorage)
            .filter((key) => key.startsWith(`${LS_PREFIX}${userId}:${COMPOSE_PREFIX}`))
            .forEach((key) => {
                const record = JSON.parse(localStorage.getItem(key));
                if (record && !records.has(record.key)) records.set(record.key, record);
            });
    } catch (e) { /* ignore */ }
    return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteLocalCompose(userId, draftId) {
    return deleteLocalDraft(userId, COMPOSE_PREFIX + draftId);
}

// ---- 添加地点表单的草稿：只有文字与已上传图片的 URL，体积很小，同步存在 localStorage，表单打开时就能恢复 ----
// 每个账号一份；键沿用 LS_PREFIX + 账号，账号注销时随 clearLocalDraftsForUser 一并清除。

const placeDraftKey = (userId) => LS_PREFIX + recordKey(userId, 'place:new');

export function saveLocalPlaceDraft(userId, draft) {
    if (!userId) return false;
    try {
        localStorage.setItem(placeDraftKey(userId), JSON.stringify({ ...draft, updatedAt: Date.now() }));
        return true;
    } catch (e) {
        return false;
    }
}

export function loadLocalPlaceDraft(userId) {
    if (!userId) return null;
    try {
        const record = JSON.parse(localStorage.getItem(placeDraftKey(userId)));
        return record && typeof record === 'object' ? record : null;
    } catch (e) {
        return null;
    }
}

export function deleteLocalPlaceDraft(userId) {
    if (!userId) return;
    try { localStorage.removeItem(placeDraftKey(userId)); } catch (e) { /* ignore */ }
}

/** 请求持久化存储，降低浏览器在空间紧张时清理草稿的概率（尽力而为）。 */
export async function requestPersistentStorage() {
    try {
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
            return await navigator.storage.persist();
        }
    } catch (e) { /* ignore */ }
    return false;
}
