import React from 'react';
import { createRoot } from 'react-dom/client';
import AdminDashboard from '../../src/admin/AdminDashboard';
import { AuthProvider } from '../../src/auth/AuthContext';
import { MotionProvider } from '../../src/motion/MotionProvider';
import { OverlayHost } from '../../src/components/overlay/OverlayHost';
import { ConfirmProvider } from '../../src/components/feedback/Confirm';
import { TipsProvider } from '../../src/components/feedback/Tips';
import '../../src/styles/tokens.css';

const auth = window.__TEST_AUTH;
createRoot(document.getElementById('root')).render(<MotionProvider><OverlayHost>
    <AuthProvider value={auth}><TipsProvider><ConfirmProvider>
        <AdminDashboard user={auth.user} token={auth.token} backendUrl={location.origin} />
    </ConfirmProvider></TipsProvider></AuthProvider>
</OverlayHost></MotionProvider>);
