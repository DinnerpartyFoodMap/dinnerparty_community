import React from 'react';
import { createRoot } from 'react-dom/client';
import AdminVenues from '../../src/admin/AdminVenues';
import { AuthProvider } from '../../src/auth/AuthContext';
import { MotionProvider } from '../../src/motion/MotionProvider';
import { OverlayHost, useOverlayContentRef } from '../../src/components/overlay/OverlayHost';
import { ConfirmProvider } from '../../src/components/feedback/Confirm';
import { TipsProvider } from '../../src/components/feedback/Tips';
import '../../src/styles/tokens.css';

// 后台「展会场馆」：真实组件 + 临时库（backend/tests/venues/test_venues_ui.js）
function Harness() {
    const frameRef = useOverlayContentRef();
    return <div ref={frameRef} style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--color-bg-base)', color: 'var(--color-text-primary)' }}>
        <div style={{ maxWidth: 700, padding: 20 }}><AdminVenues backendUrl={location.origin} /></div>
    </div>;
}
createRoot(document.getElementById('root')).render(<MotionProvider><OverlayHost>
    <AuthProvider value={{ token: window.__TEST_TOKEN, user: { admin_level: 'YUYUKO' } }}>
        <TipsProvider><ConfirmProvider><Harness /></ConfirmProvider></TipsProvider>
    </AuthProvider>
</OverlayHost></MotionProvider>);
