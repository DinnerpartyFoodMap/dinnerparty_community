import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import useRandomFood from '../../src/discovery/hooks/useRandomFood';

// The production hook, API client and community request parser run unchanged.
// Only the HTTP boundary is deferred, including responses arriving after abort.
export async function runRandomFoodBrowserTests() {
    const requests = [], feedbackEvents = [], selections = [], errors = [];
    let mapCenter = { lng: 120, lat: 30 }, controls;
    const originalFetch = window.fetch;
    const handleError = event => errors.push(event.message || String(event.reason));
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleError);
    window.fetch = (input, options = {}) => new Promise(resolve => {
        const url = new URL(input, location.origin);
        const entry = {
            path: url.pathname, query: Object.fromEntries(url.searchParams), method: options.method || 'GET',
            authorization: new Headers(options.headers).get('Authorization'),
            body: options.body ? JSON.parse(options.body) : null, signal: options.signal,
            respond: (data, status = 200) => resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }))
        };
        // Deliberately do not reject on abort: the hook must also ignore a late successful response.
        requests.push(entry);
    });
    function Harness() {
        const [config, setConfig] = useState({ open: false, token: 'account-a', origin: null, consentEnabled: false, consentVersion: 7 });
        const mapRef = useRef({ getCenter: () => ({ ...mapCenter }) });
        const feedback = useMemo(() => ({
            consent: { feedback: config.consentEnabled, version: config.consentVersion },
            record: (...args) => feedbackEvents.push(args)
        }), [config.consentEnabled, config.consentVersion]);
        const session = useRandomFood({
            ...config, mapRef, backendUrl: location.origin, feedback,
            onSelectPlace: place => selections.push(place.id), onClose: () => setConfig(previous => ({ ...previous, open: false }))
        });
        controls = { configure: next => setConfig(previous => ({ ...previous, ...next })), ...session };
        return <output id="random-food-state">{JSON.stringify({ config, result: session.result, activeOrigin: session.activeOrigin, busy: session.busy, error: session.error })}</output>;
    }
    const root = createRoot(document.getElementById('root'));
    root.render(<Harness />);
    const state = () => JSON.parse(document.getElementById('random-food-state').textContent);
    const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const until = async (condition, message) => {
        const deadline = performance.now() + 5000;
        while (!condition()) {
            if (performance.now() > deadline) throw new Error('Timed out: ' + message);
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
    };
    const equal = (actual, expected, message) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    };
    const ok = (value, message) => { if (!value) throw new Error(message); };
    const resultFor = id => ({ place: { id, name: 'Place ' + id, category: '面食', longitude: 120, latitude: 30 }, candidateCount: 8, distanceKm: 0.3 });
    const configure = async next => { controls.configure(next); await frames(); };
    const waitRequest = async count => { await until(() => requests.length >= count, 'request ' + count); equal(requests.length, count, 'a draw starts exactly one request'); return requests[count - 1]; };
    const respond = async (entry, id) => { entry.respond(resultFor(id)); await until(() => state().result?.place?.id === id && !state().busy, 'result ' + id); await frames(); };
    try {
        await until(() => !!controls, 'React harness mounts');
        equal(requests.length, 0, 'a closed session does not draw');

        await configure({ open: true });
        const first = await waitRequest(1);
        equal({ path: first.path, method: first.method, query: first.query, authorization: first.authorization }, {
            path: '/places/random', method: 'GET', query: { lat: '30', lng: '120' }, authorization: 'Bearer account-a'
        }, 'opening draws once at the map center with the current token');
        controls.drawNext(); controls.drawNext(); await frames();
        equal(requests.length, 1, 'busy draws cannot start concurrent requests');
        await respond(first, 101);
        await configure({ token: 'account-a' });
        equal(requests.length, 1, 'a routine parent rerender does not redraw an open session');

        mapCenter = { lng: 121, lat: 31 };
        controls.drawNext(); const second = await waitRequest(2);
        equal(second.query, { lat: '30', lng: '120', excludeIds: '101' }, 'another place keeps the original center after the map moves');
        await respond(second, 102);
        controls.drawNext(); const third = await waitRequest(3);
        equal(third.query, { lat: '30', lng: '120', excludeIds: '101,102' }, 'a third draw excludes both recent places');
        await respond(third, 103);
        controls.drawNext(); const fourth = await waitRequest(4);
        equal(fourth.query, { lat: '30', lng: '120', excludeIds: '102,103' }, 'only the last two successful places are excluded');
        await respond(fourth, 104);

        controls.redrawAtMapCenter(); const recentered = await waitRequest(5);
        equal(recentered.query, { lat: '31', lng: '121' }, 'redrawing at the current center clears recent history');
        await respond(recentered, 105);
        equal(state().activeOrigin, null, 'redrawing uses the map origin');

        controls.drawNext(); const closing = await waitRequest(6);
        await configure({ open: false });
        ok(closing.signal.aborted, 'closing aborts the active request');
        closing.respond(resultFor(999)); await frames();
        equal(state().result, null, 'a late response while closed is ignored');
        equal(state().error, '', 'cancellation does not surface a business error');
        controls.drawNext(); await frames();
        equal(requests.length, 6, 'draw actions cannot fetch while closed');
        await configure({ open: true });
        const reopened = await waitRequest(7);
        equal(reopened.query, { lat: '31', lng: '121' }, 'reopening draws once with fresh history and current center');
        await respond(reopened, 106);

        controls.drawNext(); const oldAccount = await waitRequest(8);
        await configure({ token: 'account-b' });
        const newAccount = await waitRequest(9);
        ok(oldAccount.signal.aborted, 'changing token aborts the previous account request');
        equal({ query: newAccount.query, authorization: newAccount.authorization }, { query: { lat: '31', lng: '121' }, authorization: 'Bearer account-b' }, 'new account gets a new round without the old exclusion history');
        await respond(newAccount, 201);
        oldAccount.respond(resultFor(998)); await frames();
        equal(state().result.place.id, 201, 'the previous account cannot overwrite the new result');

        const exhibition = { key: 'exhibition-one', label: '展会', lng: 122, lat: 32 };
        const eventsBeforeOrigin = feedbackEvents.length;
        await configure({ origin: exhibition });
        const originDraw = await waitRequest(10);
        equal(feedbackEvents.length, eventsBeforeOrigin, 'opening a new round does not report the previous session as skipped');
        equal(originDraw.query, { lat: '32', lng: '122' }, 'changing origin starts exactly one fresh round');
        await respond(originDraw, 202);
        equal(state().activeOrigin.key, 'exhibition-one', 'the active origin follows the explicit origin');
        controls.redrawAtMapCenter(); const exitOrigin = await waitRequest(11);
        equal(exitOrigin.query, { lat: '31', lng: '121' }, 'leaving the exhibition clears its history and reads the map center');
        await respond(exitOrigin, 203);

        await configure({ open: false });
        await configure({ open: true, origin: null, consentEnabled: true, consentVersion: 9 });
        const failedDraw = await waitRequest(12);
        equal({ path: failedDraw.path, method: failedDraw.method, authorization: failedDraw.authorization }, { path: '/api/community/draw', method: 'POST', authorization: 'Bearer account-b' }, 'feedback consent selects the community draw endpoint');
        equal({ center: failedDraw.body.center, exclude_ids: failedDraw.body.exclude_ids, consent_version: failedDraw.body.consent_version }, { center: { lat: 31, lng: 121 }, exclude_ids: [], consent_version: 9 }, 'community draw carries its center, empty history and consent version');
        ok(/^[a-zA-Z0-9_-]{16,80}$/.test(failedDraw.body.draw_id), 'community draw has a server-valid id');
        failedDraw.respond({ error: 'Temporary draw failure' }, 503);
        await until(() => state().error === 'Temporary draw failure' && !state().busy, 'failed community draw');
        controls.drawNext(); const retry = await waitRequest(13);
        equal(retry.body, failedDraw.body, 'retry preserves the exact draw_id, center and exclusions after failure');
        await until(() => state().busy && state().error === '', 'retry begins rendering');
        equal(state().error, '', 'retry clears the previous error');
        await respond(retry, 301);
        controls.drawNext(); const afterSuccess = await waitRequest(14);
        ok(afterSuccess.body.draw_id !== retry.body.draw_id, 'a successful draw retires its id before the next draw');
        equal(afterSuccess.body.exclude_ids, [301], 'successful community draws enter the short history');
        await respond(afterSuccess, 302);
        controls.selectPlace(); await frames();
        equal(selections, [302], 'selection delivers the currently rendered place');
        equal(state().config.open, false, 'selection closes the session');
        ok(feedbackEvents.some(event => event[0] === 'click' && event[1] === 'random' && event[2] === 302), 'selection records random feedback for that place');
        equal(errors, [], 'React lifecycle has no browser errors');
        return { passed: true, requests: requests.length, coverage: ['one draw per open', 'fixed center and recent-two history', 'recenter clears history', 'close abort and late result isolation', 'token replacement', 'origin replacement', 'community idempotent retry'] };
    } finally {
        root.unmount(); window.fetch = originalFetch;
        window.removeEventListener('error', handleError); window.removeEventListener('unhandledrejection', handleError);
    }
}
