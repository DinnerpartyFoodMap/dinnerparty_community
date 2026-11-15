// 可丢弃的本地缓存（IndexedDB）：例如地图标记快照，下次打开先用它画出标记再后台刷新。
// 与草稿（localDraftStore.js）分开存：这里的内容随时可以丢，读写失败一律当作没有缓存，不退回 localStorage
// （快照几百 KB，同步写 localStorage 会卡主线程）。

const DB_NAME = 'yuyuko-cache';
const STORE = 'entries';
const DB_VERSION = 1;

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
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        });
    }
    return dbPromise;
}

function run(mode, operation) {
    return openDb().then((db) => {
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const transaction = db.transaction(STORE, mode);
                const request = operation(transaction.objectStore(STORE));
                transaction.oncomplete = () => resolve(request.result ?? null);
                transaction.onerror = () => resolve(null);
                transaction.onabort = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    });
}

/** 读一条缓存；没有或读失败时为 null */
export function readCache(key) {
    return run('readonly', (store) => store.get(key));
}

/** 写一条缓存（结构化克隆，值里不要放函数）；失败时静默 */
export function writeCache(key, value) {
    return run('readwrite', (store) => store.put(value, key)).then(() => undefined);
}

export function deleteCache(key) {
    return run('readwrite', (store) => store.delete(key)).then(() => undefined);
}
