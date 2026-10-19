import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AdminExhibitions from '../../src/admin/AdminExhibitions';
import MapExhibition from '../../src/map/MapExhibition';
import Notice from '../../src/components/feedback/Notice';
import { AuthProvider } from '../../src/auth/AuthContext';
import { MotionProvider } from '../../src/motion/MotionProvider';
import { OverlayHost, useOverlayContentRef } from '../../src/components/overlay/OverlayHost';
import { ConfirmProvider } from '../../src/components/feedback/Confirm';
import { TipsProvider } from '../../src/components/feedback/Tips';
import '../../src/styles/tokens.css';

function Harness() {
    const [admin, setAdmin] = useState(true);
    const [notice, setNotice] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const noticeRef = useRef(null);
    const frameRef = useOverlayContentRef();
    return <div ref={frameRef} style={{ position: 'fixed', inset: 0, overflow: 'auto', background: '#eef3ed' }}>
        <button onClick={() => setAdmin(!admin)}>Toggle admin</button>
        <button onClick={() => setExpanded(!expanded)}>Resize notice</button>
        <button onClick={() => setNotice(true)}>Show notice</button>
        {admin ? <div style={{ maxWidth: 700, padding: 20 }}><AdminExhibitions backendUrl={location.origin} /></div> : <>
            {notice && <Notice ref={noticeRef} title="测试公告" canClose onClose={() => setNotice(false)} style={{ top: 67 }}>
                <div style={{ height: expanded ? 180 : 40 }}>公告内容</div>
            </Notice>}
            <MapExhibition backendUrl={location.origin} noticeRef={noticeRef} noticeVisible={notice} noticeTop={67} />
        </>}
    </div>;
}
createRoot(document.getElementById('root')).render(<MotionProvider><OverlayHost>
    <AuthProvider value={{ token: window.__TEST_TOKEN, user: { admin_level: 'YUYUKO' } }}>
        <TipsProvider><ConfirmProvider><Harness /></ConfirmProvider></TipsProvider>
    </AuthProvider>
</OverlayHost></MotionProvider>);
