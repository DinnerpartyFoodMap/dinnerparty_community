const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

// Forward-WebSocket client for NapCat's local OneBot 11 server. Connection is
// authenticated with a dedicated access token, and the logged-in QQ account
// must match the configured bot account before any event is processed.

class OneBotError extends Error {
    constructor(message, { code, retcode, action } = {}) {
        super(message);
        this.name = 'OneBotError';
        // not_connected: never sent; timeout/connection_lost: outcome unknown;
        // failed: NapCat answered with an explicit failure.
        this.code = code;
        this.retcode = retcode;
        this.action = action;
    }

    get outcomeUnknown() {
        return this.code === 'timeout' || this.code === 'connection_lost';
    }
}

const MAX_BUFFERED_EVENTS = 200;

class OneBotClient extends EventEmitter {
    constructor({ url, accessToken, expectedSelfId, logger, WebSocketImpl = globalThis.WebSocket,
        actionTimeoutMs = 15000, heartbeatTimeoutMs = 95000, maxReconnectDelayMs = 60000 }) {
        super();
        this.url = url;
        this.accessToken = accessToken;
        this.expectedSelfId = expectedSelfId ? String(expectedSelfId) : '';
        this.logger = logger;
        this.WebSocketImpl = WebSocketImpl;
        this.actionTimeoutMs = actionTimeoutMs;
        this.heartbeatTimeoutMs = heartbeatTimeoutMs;
        this.maxReconnectDelayMs = maxReconnectDelayMs;
        this.socket = null;
        this.ready = false;
        this.selfId = '';
        this.pending = new Map();
        this.bufferedEvents = [];
        this.stopped = true;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.watchdogTimer = null;
        this.lastSeenAt = 0;
        this.connectedAt = null;
        this.lastError = null;
    }

    get connected() {
        return this.ready && !!this.socket && this.socket.readyState === 1;
    }

    status() {
        return {
            connected: this.connected,
            selfId: this.selfId || null,
            connectedAt: this.connectedAt,
            lastSeenAt: this.lastSeenAt ? new Date(this.lastSeenAt).toISOString() : null,
            reconnectAttempts: this.reconnectAttempts,
            lastError: this.lastError
        };
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.connect();
        this.watchdogTimer = setInterval(() => this.checkHeartbeat(), 15000);
        this.watchdogTimer.unref?.();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.watchdogTimer);
        this.reconnectTimer = null;
        this.watchdogTimer = null;
        if (this.socket) {
            try { this.socket.close(1000, 'shutdown'); } catch (_) { /* already closed */ }
        }
        this.handleClose('stopped');
    }

    connect() {
        if (this.stopped) return;
        let socket;
        try {
            socket = new this.WebSocketImpl(this.url, {
                headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}
            });
        } catch (error) {
            this.lastError = error.message;
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        this.lastSeenAt = Date.now();
        socket.addEventListener('open', () => {
            if (socket !== this.socket) return;
            this.verifyAccount(socket);
        });
        socket.addEventListener('message', (event) => {
            if (socket !== this.socket) return;
            this.lastSeenAt = Date.now();
            this.handleFrame(event.data);
        });
        socket.addEventListener('error', (event) => {
            if (socket !== this.socket) return;
            this.lastError = (event && (event.message || event.error?.message)) || 'websocket error';
        });
        socket.addEventListener('close', (event) => {
            if (socket !== this.socket) return;
            this.socket = null;
            this.handleClose(`closed ${event && event.code}`);
            this.scheduleReconnect();
        });
    }

    async verifyAccount(socket) {
        try {
            const info = await this.call('get_login_info', {}, { timeoutMs: 10000, beforeReady: true });
            const selfId = String(info && info.user_id || '');
            if (!selfId || (this.expectedSelfId && selfId !== this.expectedSelfId)) {
                this.lastError = `logged-in account ${selfId || 'unknown'} does not match QQ_BOT_SELF_ID`;
                this.logger.error('QQ bot account mismatch; refusing connection', {
                    event: 'qqbot.connection.account_mismatch',
                    expectedSelfId: this.expectedSelfId,
                    actualSelfId: selfId || null
                });
                // Wrong account: keep retrying slowly in case NapCat is re-logged in.
                this.reconnectAttempts = Math.max(this.reconnectAttempts, 6);
                this.dropSocket(socket, 4000, 'account mismatch');
                return;
            }
            this.selfId = selfId;
            this.ready = true;
            this.reconnectAttempts = 0;
            this.lastError = null;
            this.connectedAt = new Date().toISOString();
            this.logger.notice('QQ bot connected', { event: 'qqbot.connection.ready', selfId });
            this.emit('ready', { selfId });
            const buffered = this.bufferedEvents.splice(0);
            buffered.forEach((event) => this.dispatchEvent(event));
        } catch (error) {
            this.lastError = error.message;
            this.logger.warn('QQ bot login check failed', { event: 'qqbot.connection.verify_failed', error });
            this.dropSocket(socket, 4001, 'login check failed');
        }
    }

    handleFrame(raw) {
        let data;
        try {
            data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
        } catch (_) {
            return;
        }
        if (data && data.echo != null && this.pending.has(String(data.echo))) {
            const entry = this.pending.get(String(data.echo));
            this.pending.delete(String(data.echo));
            clearTimeout(entry.timer);
            if (data.status === 'ok' || data.retcode === 0) entry.resolve(data.data);
            else entry.reject(new OneBotError(data.wording || data.message || `retcode ${data.retcode}`, { code: 'failed', retcode: data.retcode, action: entry.action }));
            return;
        }
        if (!data || !data.post_type) return;
        if (!this.ready) {
            if (this.bufferedEvents.length < MAX_BUFFERED_EVENTS) this.bufferedEvents.push(data);
            return;
        }
        this.dispatchEvent(data);
    }

    dispatchEvent(event) {
        // Events must come from the verified bot account.
        if (String(event.self_id || '') !== this.selfId) return;
        if (event.post_type === 'meta_event') return;
        try {
            this.emit(event.post_type, event);
        } catch (error) {
            this.logger.error('QQ bot event handler failed', { event: 'qqbot.event.handler_failed', postType: event.post_type, error });
        }
    }

    call(action, params = {}, { timeoutMs = this.actionTimeoutMs, beforeReady = false } = {}) {
        const socket = this.socket;
        if (!socket || socket.readyState !== 1 || (!this.ready && !beforeReady)) {
            return Promise.reject(new OneBotError('QQ bot is not connected', { code: 'not_connected', action }));
        }
        const echo = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new OneBotError(`${action} timed out`, { code: 'timeout', action }));
            }, timeoutMs);
            this.pending.set(echo, { resolve, reject, timer, action });
            try {
                socket.send(JSON.stringify({ action, params, echo }));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(echo);
                reject(new OneBotError(error.message, { code: 'not_connected', action }));
            }
        });
    }

    handleClose(reason) {
        const wasReady = this.ready;
        this.ready = false;
        this.bufferedEvents = [];
        // Requests already written to the socket may or may not have been executed.
        for (const [echo, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new OneBotError(`connection lost during ${entry.action}`, { code: 'connection_lost', action: entry.action }));
            this.pending.delete(echo);
        }
        if (wasReady) {
            this.logger.warn('QQ bot disconnected', { event: 'qqbot.connection.closed', reason });
            this.emit('disconnected', { reason });
        }
    }

    // Detach first so a slow close handshake on a half-open socket cannot delay reconnecting.
    dropSocket(socket, code, reason) {
        if (!socket || socket !== this.socket) return;
        this.socket = null;
        try { socket.close(code, reason); } catch (_) { /* already closed */ }
        this.handleClose(reason);
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        const delay = Math.min(this.maxReconnectDelayMs, 1000 * 2 ** Math.min(this.reconnectAttempts, 6));
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        this.reconnectTimer.unref?.();
    }

    // NapCat sends a heartbeat every 30 s; silence means a half-open socket.
    checkHeartbeat() {
        if (!this.socket || !this.ready) return;
        if (Date.now() - this.lastSeenAt > this.heartbeatTimeoutMs) {
            this.logger.warn('QQ bot heartbeat timed out; reconnecting', { event: 'qqbot.connection.heartbeat_timeout' });
            this.dropSocket(this.socket, 4002, 'heartbeat timeout');
        }
    }
}

module.exports = { OneBotClient, OneBotError };
