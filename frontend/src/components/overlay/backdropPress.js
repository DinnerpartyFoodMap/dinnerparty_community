// 地图可能在 touchend 时打开面板，浏览器随后补发的 click 会命中新遮罩。
// 指针点击必须来自遮罩自身的一次完整按压；不用时间窗误伤快速操作。
export function createBackdropPressGuard() {
    let pointerId = null;
    let completed = false;

    return {
        onPointerDown(event) {
            pointerId = event.target === event.currentTarget && event.button === 0 && event.isPrimary !== false
                ? event.pointerId : null;
            completed = false;
        },
        onPointerUp(event) {
            // 触屏可能隐式捕获指针，target 不一定是实际松手位置的元素。
            const doc = event.currentTarget.ownerDocument;
            const hit = doc && typeof doc.elementFromPoint === 'function'
                ? doc.elementFromPoint(event.clientX, event.clientY) : event.target;
            completed = pointerId !== null && pointerId === event.pointerId
                && event.target === event.currentTarget && hit === event.currentTarget;
            pointerId = null;
        },
        onPointerCancel() {
            pointerId = null;
            completed = false;
        },
        onPointerLeave() {
            // 触屏抬起后也会触发 leave，不能清除已完成按压的点击许可。
            pointerId = null;
        },
        consumeClick(event) {
            const allowed = event.target === event.currentTarget && (event.detail === 0 || completed);
            pointerId = null;
            completed = false;
            return allowed;
        }
    };
}
