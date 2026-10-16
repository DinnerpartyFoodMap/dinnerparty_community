// 双指缩放的收尾保护：高德 2.0 在双指中有一指先抬起后，会把剩下那根手指的移动放大约 20 倍，
// 当成平移加缩放（手指滑动 6px，地图跳 100 多 px），表现为松手时地图突然漂到别处。
// 这里在地图容器的捕获阶段拦下这根手指的 touchmove，不交给高德（高德的监听在内层 .amap-maps 上），
// 直到所有手指抬起，或第二根手指重新按下开始新的一次捏合。
// 代价：双指缩放后不抬手继续单指拖动不会生效，需要抬手后重新拖动。

/**
 * @param {HTMLElement} container 地图容器（map.getContainer()）
 * @returns {() => void} 卸载函数
 */
export function installPinchGuard(container) {
    if (!container || typeof container.addEventListener !== 'function') return () => {};
    let multiTouch = false;
    let frozen = false;

    const onStart = (event) => {
        if (event.touches.length >= 2) {
            multiTouch = true;
            frozen = false;
        }
    };
    const onEnd = (event) => {
        if (event.touches.length === 0) {
            multiTouch = false;
            frozen = false;
        } else if (multiTouch && event.touches.length === 1) {
            frozen = true;
        }
    };
    const onMove = (event) => {
        if (frozen && event.touches.length === 1) event.stopPropagation();
    };

    // passive：只拦截传播，不阻止默认行为（容器已是 touch-action: none）
    const options = { capture: true, passive: true };
    container.addEventListener('touchstart', onStart, options);
    container.addEventListener('touchend', onEnd, options);
    container.addEventListener('touchcancel', onEnd, options);
    container.addEventListener('touchmove', onMove, options);
    return () => {
        container.removeEventListener('touchstart', onStart, options);
        container.removeEventListener('touchend', onEnd, options);
        container.removeEventListener('touchcancel', onEnd, options);
        container.removeEventListener('touchmove', onMove, options);
    };
}
