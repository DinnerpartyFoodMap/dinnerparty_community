export function createWorkerClient({
    createWorker = () => new Worker(new URL('./computeWorker.js', import.meta.url),{type:'module'})
} = {}) {
    const worker = createWorker();
    let sequence = 0, destroyed = false;
    const metrics = { maxSendMs:0 };
    const pending = new Map();
    const fail = error => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear();
    };
    worker.onmessage = ({data}) => {
        const entry = pending.get(data.requestId);
        if (!entry) return;
        pending.delete(data.requestId); clearTimeout(entry.timer);
        if (data.error) entry.reject(Object.assign(new Error(data.error.message),{code:data.error.code}));
        else entry.resolve(data.result);
    };
    worker.onerror = event => {
        event.preventDefault?.();
        fail(Object.assign(new Error(event.message || 'Map worker failed'),{code:'WORKER_FAILED'}));
    };
    worker.onmessageerror = () => fail(Object.assign(new Error('Invalid map worker reply'),{code:'WORKER_FAILED'}));
    return {
        metrics,
        request(op,payload,versions = {},transfer = []) {
            if (destroyed) return Promise.reject(new Error('Map worker disposed'));
            const requestId = ++sequence;
            return new Promise((resolve,reject)=>{
                const timer = setTimeout(()=>{
                    pending.delete(requestId);
                    reject(Object.assign(new Error('Map worker timed out'),{code:'WORKER_FAILED'}));
                },15000);
                pending.set(requestId,{resolve,reject,timer});
                try {
                    const started = performance.now();
                    worker.postMessage({op,payload,...versions,requestId},transfer);
                    metrics.maxSendMs = Math.max(metrics.maxSendMs,performance.now()-started);
                }
                catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
            });
        },
        acknowledge(snapshotId) { if (!destroyed) worker.postMessage({op:'commitAck',payload:{snapshotId}}); },
        destroy() {
            if (destroyed) return;
            destroyed = true; worker.terminate(); fail(new Error('Map worker disposed'));
        }
    };
}
