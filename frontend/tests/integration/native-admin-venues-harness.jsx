import React from 'react';
import { createRoot } from 'react-dom/client';
import NativeAdminHost from '../../src/admin/NativeAdminHost';
import '../../src/styles/tokens.css';

// iOS 原生后台的展会场馆选点（backend/tests/venues/test_venues_native_admin_ui.js）：
// 真实 NativeAdminHost / useNativeAdmin / 控制器 / 会话；原生插件与全屏选点地图由测试替身代替（Vite 别名）。
class FakeNativeAdmin {
    constructor() {
        this.opens = [];
        this.responded = [];
        this.closed = [];
        this.listener = null;
        this.current = null;
        this.seq = 0;
    }

    async addListener(name, callback) {
        this.listener = callback;
        return { remove: () => { if (this.listener === callback) this.listener = null; } };
    }

    open(options) {
        this.opens.push(JSON.parse(JSON.stringify(options)));
        return new Promise((resolve) => { this.current = { id: options.id, resolve }; });
    }

    async respond(payload) { this.responded.push(JSON.parse(JSON.stringify(payload))); }

    async close({ id }) {
        this.closed.push(id);
        if (this.current?.id === id) {
            const { resolve } = this.current;
            this.current = null;
            resolve({ id, action: 'close' });
        }
    }

    /** 原生点了某个动作 */
    tap(actionId) {
        this.seq += 1;
        this.listener?.({ id: this.current?.id, type: 'action', requestId: `r${this.seq}`, actionId });
    }
}

window.__fakeNativeAdmin = new FakeNativeAdmin();
window.__hostEvents = [];
createRoot(document.getElementById('root')).render(
    <NativeAdminHost backendUrl={location.origin} token={window.__TEST_TOKEN}
        user={{ id: 'u1', username: '小町', admin_level: 'KOMACHI' }} dark={false}
        onBack={() => window.__hostEvents.push('back')}
        onOpenPlace={() => window.__hostEvents.push('openPlace')}
        onRequireAuth={() => window.__hostEvents.push('auth')}
        onUnavailable={(error) => window.__hostEvents.push(`unavailable:${error?.message || ''}`)} />
);
