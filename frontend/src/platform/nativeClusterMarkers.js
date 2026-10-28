// 高频坐标走 WebKit 带回复通道；一次只发一帧，积压只保留最新状态。
export const NATIVE_CLUSTER_CHANNEL = 'foodMapClusters';
export const NATIVE_CLUSTER_PROTOCOL = 1;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class NativeClusterSession {
    constructor({ transport, onFrame = () => {}, timeoutMs = 350, leaseMs = 800, retryMs = 2000 } = {}) {
        this.transport = transport;
        this.onFrame = onFrame;
        this.timeoutMs = timeoutMs;
        this.leaseMs = leaseMs;
        this.retryMs = retryMs;
        this.revision = 0;
        this.sessionId = null;
        this.latest = null;
        this.draining = null;
        this.stopped = false;
        this.unsupported = !transport;
        this.retryAt = 0;
    }

    async _call(message, onLateReply) {
        let timer;
        let expired = false;
        try {
            return await Promise.race([
                Promise.resolve().then(() => this.transport.postMessage(message)).then(reply => {
                    if (expired) onLateReply?.(reply);
                    return reply;
                }),
                new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('cluster-bridge-timeout')); }, this.timeoutMs); })
            ]);
        } finally { clearTimeout(timer); }
    }

    submit(frame) {
        if (this.stopped || this.unsupported || Date.now() < this.retryAt) return Promise.resolve();
        this.latest = frame;
        if (!this.draining) {
            this.draining = this._drain().finally(() => {
                this.draining = null;
                if (this.latest && !this.stopped) this.submit(this.latest);
            });
        }
        return this.draining;
    }

    async _drain() {
        try {
            if (!this.sessionId) {
                const reply = await this._call({ op: 'open', protocolVersion: NATIVE_CLUSTER_PROTOCOL }, late => {
                    if (typeof late?.sessionId === 'string') this._call({ op: 'close', sessionId: late.sessionId }).catch(() => {});
                });
                if (this.stopped) {
                    if (reply?.sessionId) await this._call({ op: 'close', sessionId: reply.sessionId });
                    return;
                }
                if (reply?.protocolVersion !== NATIVE_CLUSTER_PROTOCOL || typeof reply.sessionId !== 'string') {
                    this.unsupported = true;
                    this.latest = null;
                    return;
                }
                this.sessionId = reply.sessionId;
                this.leaseMs = Number(reply.leaseMs) > 0 ? Number(reply.leaseMs) : this.leaseMs;
            }
            while (this.latest && !this.stopped) {
                const frame = this.latest;
                this.latest = null;
                const revision = ++this.revision;
                // 白名单字段：parts 中的 DOM 引用绝不传入原生。
                const reply = await this._call({
                    op: 'frame', sessionId: this.sessionId, revision, sentAt: Date.now(),
                    viewport: frame.viewport, clip: frame.clip, markers: frame.markers, dark: !!frame.dark
                });
                if (this.stopped) return;
                if (reply?.appliedRevision !== revision) throw new Error('cluster-frame-rejected');
                this.onFrame(frame);
            }
        } catch {
            this.latest = null;
            await this._clearNative();
            this.retryAt = Date.now() + this.retryMs;
        }
    }

    async _clearNative() {
        const sessionId = this.sessionId;
        this.sessionId = null;
        if (sessionId) {
            try {
                const reply = await this._call({ op: 'close', sessionId });
                if (!reply?.closed) throw new Error('cluster-close-rejected');
            } catch {
                // 原生拒绝过期发送时间，且显示租期最多 leaseMs；等其自行收起后才恢复 PNG。
                await wait(this.leaseMs + 50);
            }
        }
        this.onFrame(null);
    }

    async stop() {
        if (this.stopped) return;
        this.stopped = true;
        this.latest = null;
        await this._clearNative();
    }
}
