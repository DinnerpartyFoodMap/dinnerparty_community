// 双指缩放的收尾保护：高德 2.0 在双指中有一指先抬起后，会把剩下那根手指的移动放大约 20 倍，
// 当成平移加缩放（手指滑动 6px，地图跳 100 多 px），表现为松手时地图突然漂到别处。
// 这里在地图容器的捕获阶段拦下这根手指的 touchmove，不交给高德（高德的监听在内层 .amap-maps 上），
// 直到所有手指抬起，或第二根手指重新按下开始新的一次捏合。
// 代价：双指缩放后不抬手继续单指拖动不会生效，需要抬手后重新拖动。

/**
 * @param {HTMLElement} container 地图容器（map.getContainer()）
 * @param {{map?: object}} options 高德相机，用于恢复纯捏合后 SDK 产生的无效中心。
 * @returns {() => void} 卸载函数
 */
export function installPinchGuard(container, {map} = {}) {
    if (!container || typeof container.addEventListener !== 'function') return () => {};
    let multiTouch = false;
    let frozen = false;
    let active = false, startCamera = null, recoveryFrame = 0;
    const endTarget = container.ownerDocument?.defaultView || container;
    const readCamera = () => {
        try {
            const center=map?.getCenter?.(),zoom=Number(map?.getZoom?.());
            const lng=center?.getLng?.() ?? center?.lng ?? center?.[0];
            const lat=center?.getLat?.() ?? center?.lat ?? center?.[1];
            return [lng,lat,zoom].every(Number.isFinite) ? {center:[lng,lat],zoom} : null;
        } catch { return null; }
    };
    const queueRecovery = () => {
        if (!map || !startCamera) return;
        if (recoveryFrame) cancelAnimationFrame(recoveryFrame);
        const before = startCamera;
        // Let the SDK finish touchend first. A centered pinch can leave its
        // center at NaN: getBounds and normal end events then fail.
        recoveryFrame = requestAnimationFrame(() => {
            recoveryFrame = 0;
            if (readCamera()) return;
            const zoom = Number(map.getZoom());
            map.setZoomAndCenter(Number.isFinite(zoom) ? zoom : before.zoom,before.center,true);
        });
    };

    const onStart = (event) => {
        if (!active) {
            if (recoveryFrame) cancelAnimationFrame(recoveryFrame);
            recoveryFrame = 0;
            // A second gesture may interrupt the queued repair while the SDK
            // is still invalid. Retain its last valid anchor until repaired.
            startCamera = readCamera() || startCamera;
            active = true;
        }
        if (event.touches.length >= 2) {
            multiTouch = true;
            frozen = false;
        }
    };
    const onEnd = (event) => {
        if (!active) return;
        if (event.touches.length === 0) {
            active = false;
            multiTouch = false;
            frozen = false;
            queueRecovery();
        } else if (multiTouch && event.touches.length === 1) {
            frozen = true;
        }
    };
    const onMove = (event) => {
        if (frozen && event.touches.length === 1) event.stopPropagation();
    };
    const onVisibility = () => {
        if (container.ownerDocument?.visibilityState !== 'hidden') { queueRecovery(); return; }
        active = multiTouch = frozen = false;
        if (recoveryFrame) cancelAnimationFrame(recoveryFrame);
        recoveryFrame = 0;
    };

    // passive：只拦截传播，不阻止默认行为（容器已是 touch-action: none）
    const options = { capture: true, passive: true };
    container.addEventListener('touchstart', onStart, options);
    endTarget.addEventListener('touchend', onEnd, options);
    endTarget.addEventListener('touchcancel', onEnd, options);
    container.addEventListener('touchmove', onMove, options);
    container.ownerDocument?.addEventListener('visibilitychange',onVisibility);
    return () => {
        container.removeEventListener('touchstart', onStart, options);
        endTarget.removeEventListener('touchend', onEnd, options);
        endTarget.removeEventListener('touchcancel', onEnd, options);
        container.removeEventListener('touchmove', onMove, options);
        container.ownerDocument?.removeEventListener('visibilitychange',onVisibility);
        if (recoveryFrame) cancelAnimationFrame(recoveryFrame);
    };
}
