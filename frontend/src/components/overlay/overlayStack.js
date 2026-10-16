// 浮层栈：按真实打开顺序登记所有弹窗、面板与菜单（非 React 模块，原生控件桥接与 mediaPicker 也会读取）。
//
// - 系统返回 / Escape 只关闭最上层；同级先关最上层，嵌套预览先于详情关闭。
// - 关闭途中（退出动画未结束）的浮层仍在栈中：继续消费返回键、保持原生控件收起，避免点击/返回击穿。
// - 同一次关闭请求只执行一次；关闭被拒绝（例如草稿保护）后恢复可关闭状态。
// - 返回键复用 platform/backButton，只登记一个处理函数，不与其他返回栈并存竞争。

import { pushBackHandler, BACK_PRIORITY } from '../../platform/backButton.js';

let seq = 0;
const entries = [];
const listeners = new Set();
let removeBackHandler = null;
let notifyScheduled = false;

function snapshot() {
    return entries.map((entry) => ({ ...entry.spec, id: entry.id, order: entry.order, status: entry.status }));
}

function notify() {
    // 同一帧内的多次登记合并通知
    if (notifyScheduled) return;
    notifyScheduled = true;
    Promise.resolve().then(() => {
        notifyScheduled = false;
        const list = snapshot();
        for (const listener of Array.from(listeners)) {
            try { listener(list); } catch (e) { console.warn('浮层栈监听失败', e); }
        }
    });
}

function syncBackHandler() {
    if (entries.length && !removeBackHandler) {
        removeBackHandler = pushBackHandler(() => handleBack(), BACK_PRIORITY.OVERLAY);
    } else if (!entries.length && removeBackHandler) {
        removeBackHandler();
        removeBackHandler = null;
    }
}

function topOpen(predicate = () => true) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.status === 'open' && predicate(entry)) return entry;
    }
    return null;
}

function requestClose(entry, reason) {
    if (!entry || entry.pending || entry.status !== 'open') return true;
    const onClose = entry.spec.onClose;
    if (typeof onClose !== 'function') return false;
    entry.pending = true;
    let result;
    try {
        result = onClose(reason);
    } catch (e) {
        entry.pending = false;
        console.warn('关闭浮层失败', e);
        return true;
    }
    const release = () => { entry.pending = false; };
    if (result && typeof result.then === 'function') result.then(release, release);
    else Promise.resolve().then(release);
    return true;
}

function handleBack() {
    const entry = topOpen((e) => e.spec.consumeBack !== false);
    if (entry) return requestClose(entry, 'back');
    // 只剩正在关闭的浮层：消费返回键，避免击穿到页面返回
    return entries.some((e) => e.status === 'closing' && e.spec.consumeBack !== false);
}

if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        const entry = topOpen((e) => e.spec.closeOnEscape !== false);
        if (!entry) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose(entry, 'escape');
    });
}

/**
 * 登记浮层。spec: { kind, label, modal, portal, onClose, closeOnEscape, consumeBack, suspendNative }
 * 返回句柄：update(patch) / setStatus('open'|'closing') / unregister() / requestClose(reason)
 */
export function registerOverlay(spec) {
    const entry = { id: ++seq, order: seq, spec: { suspendNative: true, ...spec }, status: 'open', pending: false };
    entries.push(entry);
    syncBackHandler();
    notify();
    return {
        id: entry.id,
        order: entry.order,
        update(patch) {
            entry.spec = { ...entry.spec, ...patch };
            notify();
        },
        setStatus(status) {
            if (entry.status === status) return;
            entry.status = status;
            if (status === 'open') entry.pending = false;
            notify();
        },
        requestClose(reason = 'programmatic') {
            return requestClose(entry, reason);
        },
        isTop() {
            return topOpen() === entry;
        },
        unregister() {
            const index = entries.indexOf(entry);
            if (index >= 0) entries.splice(index, 1);
            syncBackHandler();
            notify();
        }
    };
}

export function getOverlayEntries() {
    return snapshot();
}

export function subscribeOverlays(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** 是否有需要收起原生控件的浮层（含正在退出的浮层）。 */
export function hasNativeSuspendingOverlay(list = snapshot()) {
    return list.some((entry) => entry.suspendNative !== false);
}

/** 关闭最上层浮层（例如原生控件需要接管时）。 */
export function closeTopOverlay(reason = 'programmatic') {
    const entry = topOpen();
    return entry ? requestClose(entry, reason) : false;
}
