// A queue owns only the latest reconciliation. SDK calls themselves cannot be preempted.
export function createMarkerRenderQueue({
    budgetMs = 4, maxSdkBatch = 4, now = () => performance.now(),
    scheduleFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, onSlice = () => {}
} = {}) {
    let task = null, frame = null, paused = false, destroyed = false;
    const cancel = () => {
        if (frame !== null) cancelFrame(frame);
        frame = null;
        if (!task) return false;
        const old = task; task = null;
        old.iterator.return?.(); old.resolve(false);
        return true;
    };
    const schedule = () => {
        if (!destroyed && !paused && task && frame === null) frame = scheduleFrame(run);
    };
    const run = () => {
        frame = null;
        if (!task || paused || destroyed) return;
        const current = task, started = now();
        let count = 0, writes = 0;
        try {
            while (task === current) {
                const step = current.iterator.next();
                if (step.done) {
                    task = null; current.onComplete?.(current.version); current.resolve(true); break;
                }
                if (typeof step.value === 'function') step.value();
                else step.value?.run?.();
                count++;
                if (step.value?.sdk !== false) writes++;
                if (writes >= maxSdkBatch || now()-started >= budgetMs) break;
            }
        } catch (error) { task = null; current.reject(error); }
        onSlice({version:current.version,ms:now()-started,operations:count});
        schedule();
    };
    return {
        get busy() { return !!task; },
        replace({version,operations,onComplete}) {
            cancel();
            if (destroyed) return Promise.resolve(false);
            return new Promise((resolve,reject)=>{
                task = {version,iterator:operations[Symbol.iterator](),onComplete,resolve,reject}; schedule();
            });
        },
        cancel,
        pause() { paused = true; if(frame !== null)cancelFrame(frame); frame = null; },
        resume() { paused = false; schedule(); },
        destroy() { destroyed = true; cancel(); }
    };
}
