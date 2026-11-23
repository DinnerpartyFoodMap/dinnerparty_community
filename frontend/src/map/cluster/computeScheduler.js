// Coalesce arrivals without building a backlog of stale camera/data work.
export function createComputeScheduler({
    execute, onResult, onError = () => {},
    now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout
}) {
    let sequence = 0, latest = 0, waiting = null, running = false, timer = null, firstAt = null, destroyed = false;
    const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
    const pump = () => {
        clear();
        if (destroyed || running || !waiting) return;
        const delay = waiting.due - now();
        if (delay > 0) { timer = setTimer(pump, delay); return; }
        const target = waiting;
        waiting = null; firstAt = null; running = true;
        Promise.resolve().then(() => execute(target)).then(
            value => { if (!destroyed && target.requestId === latest) return onResult(value, target); }
        ).catch(error => {
            if (!destroyed && target.requestId === latest) onError(error,target);
        }).finally(() => { running = false; pump(); });
    };
    return {
        submit(target) {
            if (destroyed) return null;
            const time = now();
            firstAt ??= time;
            latest = ++sequence;
            waiting = { ...target, requestId:latest,
                due: target.kind === 'data' && !target.immediate ? Math.min(time + 16, firstAt + 50) : time };
            pump();
            return latest;
        },
        invalidate() { latest = ++sequence; waiting = null; firstAt = null; clear(); },
        destroy() { destroyed = true; this.invalidate(); }
    };
}
