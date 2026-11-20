// 用户操作：页面上的触摸、按键、滚轮，以及地图被拖动 / 缩放（MapView 转发，iOS 原生底图的手势不经过网页触摸事件）。
// 底栏小伙伴据此判断多久没操作该睡了，睡着的醒来。
const listeners = new Set();
const OPTIONS = { capture: true, passive: true };
const TYPES = ['pointerdown', 'keydown', 'wheel'];
let attached = false;

function notify() {
    for (const listener of listeners) listener();
}

/** 有一次操作（地图开始移动时由 MapView 调用） */
export function noteCompanionActivity() {
    notify();
}

/** 订阅操作；第一个订阅者出现时才监听页面事件，最后一个取消时移除 */
export function subscribeCompanionActivity(listener) {
    listeners.add(listener);
    if (!attached && typeof window !== 'undefined') {
        attached = true;
        for (const type of TYPES) window.addEventListener(type, notify, OPTIONS);
    }
    return () => {
        listeners.delete(listener);
        if (!listeners.size && attached) {
            attached = false;
            for (const type of TYPES) window.removeEventListener(type, notify, OPTIONS);
        }
    };
}
