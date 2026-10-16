'use strict';

/** 仅实现会话存储用到的命令的内存版 Redis，用于不依赖 Redis 服务的测试。 */
class FakeRedis {
    constructor() {
        this.strings = new Map();
        this.sets = new Map();
        this.ready = true;
        this.failNext = null;
    }

    isReady() { return this.ready; }

    _check() {
        if (this.failNext) {
            const error = this.failNext;
            this.failNext = null;
            throw error;
        }
    }

    async get(key) { this._check(); return this.strings.has(key) ? this.strings.get(key) : null; }
    async set(key, value) { this._check(); this.strings.set(key, String(value)); return 'OK'; }
    async exists(key) { this._check(); return this.strings.has(key) ? 1 : 0; }
    async del(key) {
        this._check();
        const had = this.strings.delete(key) || this.sets.delete(key);
        return had ? 1 : 0;
    }
    async expire() { this._check(); return 1; }
    async sadd(key, ...members) {
        this._check();
        const set = this.sets.get(key) || new Set();
        members.forEach((m) => set.add(String(m)));
        this.sets.set(key, set);
        return members.length;
    }
    async srem(key, ...members) {
        this._check();
        const set = this.sets.get(key);
        if (!set) return 0;
        let removed = 0;
        members.forEach((m) => { if (set.delete(String(m))) removed += 1; });
        return removed;
    }
    async smembers(key) { this._check(); return [...(this.sets.get(key) || [])]; }
    async mget(...keys) { this._check(); return keys.map((k) => (this.strings.has(k) ? this.strings.get(k) : null)); }
}

module.exports = { FakeRedis };
