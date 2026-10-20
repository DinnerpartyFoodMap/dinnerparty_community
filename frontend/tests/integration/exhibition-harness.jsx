import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AdminExhibitions from '../../src/admin/AdminExhibitions';
import MapExhibition, { ExhibitionPanel, useCurrentExhibition } from '../../src/map/MapExhibition';
import { exhibitionRandomOrigin } from '../../src/map/exhibition';
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
    const [open, setOpen] = useState(false);
    const [origin, setOrigin] = useState(null);
    const noticeRef = useRef(null);
    const frameRef = useOverlayContentRef();
    // 与 App 相同：只在地图页轮询；入口在外层，面板由地图渲染（这里直接渲染网页面板）
    const exhibition = useCurrentExhibition(location.origin, !admin);
    return <div ref={frameRef} style={{ position: 'fixed', inset: 0, overflow: 'auto', background: '#eef3ed' }}>
        <button onClick={() => setAdmin(!admin)}>Toggle admin</button>
        <button onClick={() => setExpanded(!expanded)}>Resize notice</button>
        <button onClick={() => setNotice(true)}>Show notice</button>
        {admin ? <div style={{ maxWidth: 700, padding: 20 }}><AdminExhibitions backendUrl={location.origin} /></div> : <>
            {notice && <Notice ref={noticeRef} title="测试公告" canClose onClose={() => setNotice(false)} style={{ top: 67 }}>
                <div style={{ height: expanded ? 180 : 40 }}>公告内容</div>
            </Notice>}
            <MapExhibition exhibition={exhibition} open={open} onOpen={() => setOpen(true)}
                backendUrl={location.origin} noticeRef={noticeRef} noticeVisible={notice} noticeTop={67} />
            <ExhibitionPanel open={open} exhibition={exhibition} backendUrl={location.origin} onClose={() => setOpen(false)}
                onRandomNearby={(item) => { setOpen(false); setOrigin(exhibitionRandomOrigin(item)); }} />
            {origin && <output aria-label="随机中心">{`${origin.label} ${origin.lat},${origin.lng}`}</output>}
        </>}
    </div>;
}
createRoot(document.getElementById('root')).render(<MotionProvider><OverlayHost>
    <AuthProvider value={{ token: window.__TEST_TOKEN, user: { admin_level: 'YUYUKO' } }}>
        <TipsProvider><ConfirmProvider><Harness /></ConfirmProvider></TipsProvider>
    </AuthProvider>
</OverlayHost></MotionProvider>);
