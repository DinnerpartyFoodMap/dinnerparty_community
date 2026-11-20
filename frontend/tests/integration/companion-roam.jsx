// 底栏小伙伴的状态预览：npm run dev 后在窄窗口（≤768px）打开 /tests/integration/companion-roam.html。
// 用真的 CompanionRoam（状态机、Live2D），旁边是假的工具栏和右侧按钮组（标了 data-companion-perch，与地图页相同），
// 按钮直接把它推到某个状态：刚投喂、饿了、上拉更多功能、去爬、睡觉。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CompanionRoam from '../../src/companion/CompanionRoam';
import { DEFAULT_COMPANION } from '../../src/companion/useCompanion';
import { MotionProvider } from '../../src/motion/MotionProvider';
import '../../src/styles/tokens.css';

const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const director = () => window.__foodmapCompanion;

function Harness() {
    const [fedAt, setFedAt] = useState(() => iso(Date.now() - 10 * HOUR));
    const [drawer, setDrawer] = useState(false);
    const companion = { active: DEFAULT_COMPANION, satiety: 3, owned: [], fed_at: fedAt, adopted_at: iso(Date.now() - 99 * HOUR) };
    const button = (label, onClick) => <button type="button" data-test={label} onClick={onClick}>{label}</button>;
    return <MotionProvider>
        <div style={{ position: 'fixed', inset: 0, background: '#dfe8dc', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', flexWrap: 'wrap', gap: 4, zIndex: 3000 }}>
                {button('feed', () => setFedAt(iso(Date.now())))}
                {button('hungry', () => setFedAt(iso(Date.now() - 72 * HOUR)))}
                {button('normal', () => setFedAt(iso(Date.now() - 10 * HOUR)))}
                {button('drawer', () => setDrawer((open) => !open))}
                {button('climb', () => { const d = director(); d.random = () => 0.05; d.state.lastClimbAt = -Infinity; d.state.last = 'standby'; d.restart(); })}
                {button('sleep', () => { const d = director(); d.lastActivity = Date.now() - 10 * 60e3; d.restart(); })}
                {button('wake', () => director().noteActivity())}
                <span data-test="phase" />
            </div>
            <div style={{ position: 'absolute', left: 12, right: 12, bottom: 4, height: 72 + (drawer ? 280 : 0), borderRadius: 32,
                background: 'rgba(255,255,255,0.75)', zIndex: 2500, transition: 'height 400ms cubic-bezier(0.2, 0.9, 0.3, 1)' }} />
            {!drawer && <div data-companion-perch="" style={{ position: 'absolute', right: 12, bottom: 80, zIndex: 2000, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[0, 1, 2].map((key) => <div key={key} style={{ width: 44, height: 44, borderRadius: '50%', background: '#3a6ea5' }} />)}
            </div>}
            <CompanionRoam backendUrl="" token={null} companion={companion} bottom={80}
                drawer={{ open: drawer, dragging: false, height: drawer ? 280 : 0 }} column={undefined} />
        </div>
    </MotionProvider>;
}

createRoot(document.getElementById('root')).render(<Harness />);
setInterval(() => {
    const phase = document.querySelector('[data-test="phase"]');
    if (phase && director()) phase.textContent = director().phase;
}, 250);
