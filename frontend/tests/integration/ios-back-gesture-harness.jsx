import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createIosBackGesture } from '../../src/platform/iosBackGesture.js';
import { dispatchBack, useBackHandler, BACK_PRIORITY } from '../../src/platform/backButton.js';
import { getOverlayEntries } from '../../src/components/overlay/overlayStack.js';
import { MotionProvider } from '../../src/motion/MotionProvider';
import PageTransition from '../../src/motion/PageTransition';
import { OverlayHost, useOverlayContentRef } from '../../src/components/overlay/OverlayHost';
import MotionSurface from '../../src/components/overlay/MotionSurface';
import { ConfirmProvider, useConfirm } from '../../src/components/feedback/Confirm';
import '../../src/styles/tokens.css';

// Route DOM, overlay registration, back stack and confirmation all use production components.
export async function runIosBackGestureBrowserTests() {
    let controls, dispatchCount = 0;
    const dispatchPositions = [], errors = [], previewEvents = [];
    const onError = event => errors.push(event.message || String(event.reason));
    const onPreview = event => previewEvents.push(event.detail?.active);
    addEventListener('error', onError); addEventListener('unhandledrejection', onError);
    addEventListener('foodmap:edge-back-preview', onPreview);
    function Harness() {
        const [config, setConfig] = useState({ route: true, overlays: [], deny: false, confirm: false, nestedDepth: 0 });
        const contentRef = useOverlayContentRef();
        const confirm = useConfirm();
        useBackHandler(config.route, async () => {
            if (config.deny) return true;
            if (config.confirm && !(await confirm('保留这页未提交的输入？'))) return true;
            setConfig(previous => ({ ...previous, route: false }));
            return true;
        }, BACK_PRIORITY.PAGE);
        controls = { configure: next => setConfig(previous => ({ ...previous, ...next })), config };
        return <>
            <main ref={contentRef} style={{ position: 'fixed', inset: 0, background: '#ddeee4' }}>
                <PageTransition pageKey={config.route ? 'draft' : null} direction="pop">
                    <section style={{ padding: 24 }}><h1>未提交页面</h1><input data-gesture-route-input defaultValue="route draft" /></section>
                </PageTransition>
            </main>
            {config.overlays.map(name => <MotionSurface key={name} show portal preset="fade" className="fm-surface"
                data-gesture-overlay={name} overlay={{ kind: 'test-gesture', label: name, modal: false, onClose: () => setConfig(previous => ({ ...previous, overlays: previous.retainOverlay ? previous.overlays : previous.overlays.filter(item => item !== name) })) }}
                style={{ position: 'fixed', inset: '60px 16px', padding: 24 }}>
                <h2>{name}</h2><input data-gesture-overlay-input={name} defaultValue={name + ' draft'} />
            </MotionSurface>)}
            {config.nestedDepth > 0 && <MotionSurface show portal preset="fade" className="fm-surface" data-gesture-nested-shell
                overlay={{ kind: 'test-nested-gesture', modal: false, onClose: () => setConfig(previous => ({ ...previous, nestedDepth: previous.nestedDepth - 1 })) }}
                style={{ position: 'fixed', inset: '40px 12px', padding: 0, '--color-bg-base': '#fff' }}>
                <style>{'.gesture-nested-layer{position:absolute;inset:0;padding:24px;visibility:hidden}.gesture-nested-layer.is-top{visibility:visible}'}</style>
                <div style={{ position: 'relative', height: '100%' }}>
                    <section className={'gesture-nested-layer' + (config.nestedDepth === 1 ? ' is-top' : '')}
                        data-gesture-nested-previous data-native-back-previous={config.nestedDepth > 1 ? '' : undefined}>
                        <h2>上一层</h2><input data-gesture-previous-input defaultValue="previous draft" />
                    </section>
                    {config.nestedDepth > 1 && <section className="gesture-nested-layer is-top" data-native-back-content>
                        <h2>内部编辑页</h2><input data-gesture-nested-input defaultValue="nested draft" />
                    </section>}
                </div>
            </MotionSurface>}
        </>;
    }
    const root = createRoot(document.getElementById('root'));
    root.render(<MotionProvider><OverlayHost><ConfirmProvider><Harness /></ConfirmProvider></OverlayHost></MotionProvider>);
    const controller = createIosBackGesture({ dispatch: () => {
        dispatchCount += 1;
        dispatchPositions.push([...document.querySelectorAll('.fm-route-transition,[data-gesture-overlay]')].map(node => ({ name: node.dataset.gestureOverlay || 'route', x: node.getBoundingClientRect().x })));
        return dispatchBack();
    } });
    const equal = (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); };
    const ok = (value, message) => { if (!value) throw new Error(message); };
    const near = (actual, expected, message) => ok(Math.abs(actual - expected) < 1, message + ': expected ' + expected + ', got ' + actual);
    const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const until = async (condition, message) => {
        const deadline = performance.now() + 5000;
        while (!condition()) { if (performance.now() > deadline) throw new Error('Timed out: ' + message); await new Promise(resolve => requestAnimationFrame(resolve)); }
    };
    const translated = node => Number.parseFloat(getComputedStyle(node).translate) || 0;
    const idle = async node => { await until(() => !node.isConnected || Math.abs(translated(node)) < 0.5, 'surface returns to its starting position'); await frames(); };
    const configure = async next => { controls.configure(next); await frames(); };
    const send = (phase, progress = 0, committed = false) => controller.handle({ phase, progress, velocity: 0, ...(phase === 'end' ? { committed } : {}) });
    const commit = () => { send('begin'); send('change', 0.7); const settled = send('end', 0.7, true); send('end', 0.7, true); return settled; };
    try {
        await until(() => !!controls && !!document.querySelector('[data-gesture-route-input]'), 'route mounts');
        let route = document.querySelector('.fm-route-transition');
        const input = document.querySelector('[data-gesture-route-input]');
        input.value = 'edited route draft';
        route.style.willChange = 'opacity';
        route.style.pointerEvents = 'auto';
        const originalTransform = route.style.transform;
        send('begin'); send('change', 0.35); await frames();
        equal(previewEvents, [true], 'begin reveals the map preview before moving a route');
        near(translated(route), innerWidth * 0.35, 'route follows the native gesture progress');
        equal(route.style.transform, originalTransform, 'gesture translate does not overwrite the page animation transform');
        equal(dispatchCount, 0, 'begin and change do not navigate');
        send('cancel', 0.35); await idle(route);
        ok(document.querySelector('[data-gesture-route-input]') === input, 'cancel retains the original input DOM');
        equal(input.value, 'edited route draft', 'cancel retains the edited input value');
        equal({ willChange: route.style.willChange, pointerEvents: route.style.pointerEvents }, { willChange: 'opacity', pointerEvents: 'auto' }, 'cancel restores the original surface interaction styles');
        equal(dispatchCount, 0, 'cancel does not dispatch back');
        equal(previewEvents, [true, false], 'cancel hides the route preview exactly once');

        const firstCommit = commit();
        await until(() => dispatchCount === 1 && !route.isConnected, 'committed route returns');
        await firstCommit;
        equal(previewEvents.slice(-2), [true, false], 'commit also closes the route preview');
        equal(dispatchCount, 1, 'duplicate end events dispatch only once');
        await send('end', 0.7, true); await frames();
        equal(dispatchCount, 1, 'a late duplicate end after settlement cannot dispatch again');
        ok(dispatchPositions[0].some(position => position.name === 'route' && position.x >= innerWidth - 1), 'the route finishes sliding right before back is dispatched');

        await configure({ route: true, deny: true });
        await until(() => !!document.querySelector('[data-gesture-route-input]'), 'guarded route mounts');
        route = document.querySelector('.fm-route-transition');
        await until(() => getComputedStyle(route).opacity === '1', 'route entry completes');
        const guardedInput = document.querySelector('[data-gesture-route-input]');
        guardedInput.value = 'guarded draft';
        await commit(); await until(() => dispatchCount === 2, 'guard consumes back'); await idle(route);
        ok(route.isConnected, 'a refused back retains the page');
        ok(document.querySelector('[data-gesture-route-input]') === guardedInput, 'a refused back retains its input DOM');
        equal(guardedInput.value, 'guarded draft', 'a refused back retains its input value');

        await configure({ deny: false, confirm: true });
        const confirmationSettled = commit();
        await until(() => dispatchCount === 3 && !!document.querySelector('[role="alertdialog"]'), 'real confirmation opens');
        await idle(route);
        equal(guardedInput.value, 'guarded draft', 'pending confirmation does not discard the draft');
        const dialog = document.querySelector('[role="alertdialog"]');
        [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === '取消').click();
        await until(() => !document.querySelector('[role="alertdialog"]'), 'confirmation cancellation finishes');
        await confirmationSettled;
        ok(route.isConnected, 'canceling confirmation leaves the old route visible');
        ok(document.querySelector('[data-gesture-route-input]') === guardedInput, 'confirmation cancel retains input DOM');

        await configure({ confirm: false, overlays: ['one'] });
        await until(() => !!document.querySelector('[data-gesture-overlay="one"][data-native-back-surface]'), 'MotionSurface exposes the registered back surface');
        let overlay = document.querySelector('[data-gesture-overlay="one"]');
        await until(() => getComputedStyle(overlay).opacity === '1', 'overlay entry completes');
        const overlayInput = document.querySelector('[data-gesture-overlay-input="one"]');
        overlayInput.value = 'edited overlay draft';
        const overlayId = Number(overlay.dataset.nativeBackSurface);
        ok(getOverlayEntries().some(entry => entry.id === overlayId && entry.status === 'open'), 'the surface maps to its actual overlay stack entry');
        send('begin'); send('change', 0.3); await frames();
        ok(translated(overlay) > 0, 'the top overlay follows the gesture');
        near(translated(route), 0, 'the underlying route stays in place');
        send('cancel', 0.3); await idle(overlay);
        equal(overlayInput.value, 'edited overlay draft', 'canceling an overlay gesture retains its input');

        send('begin'); send('change', 0.3);
        await configure({ overlays: ['one', 'two'] });
        await until(() => { const node = document.querySelector('[data-gesture-overlay="two"]'); return node && getComputedStyle(node).opacity === '1'; }, 'new overlay appears during a gesture');
        const newer = document.querySelector('[data-gesture-overlay="two"]');
        send('change', 0.5); send('end', 0.5, true); await idle(overlay);
        near(translated(newer), 0, 'a gesture cannot migrate to a newly opened overlay');
        equal(dispatchCount, 3, 'a changed top overlay invalidates the previous gesture before dispatch');
        equal(controls.config.overlays, ['one', 'two'], 'a new overlay cannot be dismissed by the previous gesture');

        await configure({ overlays: ['one'] });
        await until(() => getOverlayEntries().length === 1, 'newer overlay fully closes');
        overlay = document.querySelector('[data-gesture-overlay="one"]');
        const overlayCommit = commit();
        await until(() => dispatchCount === 4 && !overlay.isConnected, 'committed top overlay closes');
        await overlayCommit;
        ok(route.isConnected, 'committing an overlay does not dismiss its underlying page');
        equal(guardedInput.value, 'guarded draft', 'underlying input survives the overlay back');

        await configure({ route: false });
        await until(() => !document.querySelector('.fm-route-transition') && getOverlayEntries().length === 0, 'no draggable target remains');
        send('begin'); send('change', 0.42); await frames();
        let indicator = document.querySelector('[data-ios-back-progress]');
        ok(indicator && indicator.textContent.includes('‹'), 'a targetless gesture still shows the left-edge back indicator');
        near(Number(indicator.dataset.progress), 0.42, 'the targetless indicator follows native progress');
        await send('cancel', 0.42);
        ok(!document.querySelector('[data-ios-back-progress]'), 'cancel removes the targetless indicator');
        equal(dispatchCount, 4, 'targetless cancellation does not dispatch back');
        await commit();
        equal(dispatchCount, 5, 'targetless commit dispatches only once despite duplicate end');
        ok(!document.querySelector('[data-ios-back-progress]'), 'targetless commit removes its indicator');

        await configure({ route: true });
        await until(() => !!document.querySelector('.fm-route-transition'), 'route remounts for disposal');
        route = document.querySelector('.fm-route-transition');
        await until(() => getComputedStyle(route).opacity === '1', 'route entry finishes before disposal');

        await configure({ confirm: true });
        const secondSwipeInput = document.querySelector('[data-gesture-route-input]');
        secondSwipeInput.value = 'draft protected through two swipes';
        let oldDispatchFinished = false;
        const pendingConfirmBack = commit();
        pendingConfirmBack.then(() => { oldDispatchFinished = true; });
        await until(() => dispatchCount === 6 && !!document.querySelector('[role="alertdialog"]'), 'second confirmation opens');
        await idle(route);
        const gestureDialog = document.querySelector('[role="alertdialog"]');
        await until(() => getComputedStyle(gestureDialog).opacity === '1', 'confirmation is ready for another gesture');
        ok(!oldDispatchFinished, 'the first back dispatch remains pending while confirmation is open');
        send('begin'); send('change', 0.4); await frames();
        ok(translated(gestureDialog) > 0, 'a second gesture can move confirmation while the first dispatch is pending');
        near(translated(route), 0, 'the protected route stays restored during the second gesture');
        const confirmGestureSettled = send('end', 0.7, true);
        send('end', 0.7, true);
        await confirmGestureSettled; await pendingConfirmBack;
        await until(() => !gestureDialog.isConnected, 'second gesture cancels confirmation');
        equal(dispatchCount, 7, 'the confirmation gesture dispatches once and duplicate end does not repeat it');
        ok(route.isConnected && document.querySelector('[data-gesture-route-input]') === secondSwipeInput, 'second gesture cancellation retains the original protected page and input DOM');
        equal(secondSwipeInput.value, 'draft protected through two swipes', 'the old dispatch finally cannot discard the protected draft');
        near(translated(route), 0, 'the old dispatch finally cannot move the restored route');

        await configure({ confirm: false, nestedDepth: 2 });
        await until(() => !!document.querySelector('[data-gesture-nested-shell][data-native-back-surface]'), 'nested MotionSurface registers');
        const shell = document.querySelector('[data-gesture-nested-shell]');
        await until(() => getComputedStyle(shell).opacity === '1', 'nested shell entry finishes');
        const currentLayer = shell.querySelector('[data-native-back-content]');
        const previousLayer = shell.querySelector('[data-gesture-nested-previous]');
        const nestedInput = shell.querySelector('[data-gesture-nested-input]');
        const previousInput = shell.querySelector('[data-gesture-previous-input]');
        nestedInput.value = 'nested edit survives cancellation';
        previousInput.value = 'previous edit is retained';
        const shellStartX = shell.getBoundingClientRect().x;
        equal(getComputedStyle(previousLayer).visibility, 'hidden', 'the previous nested layer starts hidden');
        send('begin'); send('change', 0.3); await frames();
        ok(translated(currentLayer) > 0, 'drag moves only the nested current page');
        near(shell.getBoundingClientRect().x, shellStartX, 'the retained MotionSurface shell does not move');
        equal(getComputedStyle(previousLayer).visibility, 'visible', 'drag reveals the previous nested page');
        ok(getComputedStyle(currentLayer).backgroundColor !== 'rgba(0, 0, 0, 0)', 'the moving nested page has a solid background');
        await send('cancel', 0.3); await idle(currentLayer);
        equal(getComputedStyle(previousLayer).visibility, 'hidden', 'cancel restores the previous layer visibility');
        ok(shell.querySelector('[data-gesture-nested-input]') === nestedInput, 'nested cancellation keeps the same input DOM');
        equal(nestedInput.value, 'nested edit survives cancellation', 'nested cancellation keeps the edit');
        const nestedStarted = performance.now();
        let sampleShell = true, shellMoved = false;
        const sample = () => { if (Math.abs(shell.getBoundingClientRect().x - shellStartX) > 1 || !shell.isConnected) shellMoved = true; if (sampleShell) requestAnimationFrame(sample); };
        sample(); await commit(); sampleShell = false;
        const nestedElapsedMs = performance.now() - nestedStarted;
        await until(() => !currentLayer.isConnected && controls.config.nestedDepth === 1, 'nested commit pops the current layer');
        equal(dispatchCount, 8, 'nested commit dispatches one back operation');
        ok(shell.isConnected && document.querySelector('[data-gesture-nested-shell]') === shell && !shellMoved, 'nested commit continuously retains the stationary shell');
        ok(nestedElapsedMs < 450, 'nested pop does not wait for the old 450ms shell timeout: ' + nestedElapsedMs);
        equal(getComputedStyle(previousLayer).visibility, 'visible', 'the previous nested page becomes the visible top page');
        ok(shell.querySelector('[data-gesture-previous-input]') === previousInput, 'nested pop retains the previous input DOM');
        equal(previousInput.value, 'previous edit is retained', 'nested pop keeps the previous layer draft');
        await configure({ nestedDepth: 0 });
        await until(() => getOverlayEntries().length === 0, 'nested shell closes before route disposal');

        await configure({ overlays: ['retained'], retainOverlay: true });
        await until(() => { const node = document.querySelector('[data-gesture-overlay="retained"]'); return node && getComputedStyle(node).opacity === '1'; }, 'retained overlay opens');
        const retained = document.querySelector('[data-gesture-overlay="retained"]');
        await commit(); await idle(retained);
        near(translated(retained), 0, 'a retained shell returns without an earlier filled animation overriding it');
        equal(dispatchCount, 9, 'retained-shell return dispatches once');
        await configure({ overlays: [], retainOverlay: false });
        await until(() => getOverlayEntries().length === 0, 'retained overlay closes');

        send('begin'); send('change', 0.25); await frames();
        ok(translated(route) > 0, 'a later page gesture can start');
        controller.dispose(); await idle(route);
        equal(dispatchCount, 9, 'disposing during a gesture does not navigate');
        ok(previewEvents.length >= 2 && previewEvents.length % 2 === 0, 'route preview events have balanced begin and release pairs');
        previewEvents.forEach((value, index) => equal(value, index % 2 === 0, 'route preview true/false events alternate without stale cleanup'));
        equal(errors, [], 'gesture lifecycle has no browser errors');
        return { passed: true, dispatchCount, previewEventCount: previewEvents.length, nestedElapsedMs: Math.round(nestedElapsedMs), coverage: ['progress translates only', 'cancel keeps DOM and draft', 'commit once after slide', 'guard recovery', 'real confirmation button and second-gesture cancellation', 'overlay stack targeting', 'new overlay invalidates old gesture', 'targetless indicator progress and cancellation', 'nested page pop retains shell and drafts', 'balanced route preview events', 'dispose recovery'] };
    } finally {
        controller.dispose(); root.unmount();
        removeEventListener('error', onError); removeEventListener('unhandledrejection', onError);
        removeEventListener('foodmap:edge-back-preview', onPreview);
    }
}
