// The located position reaches PUT /users/me/location even when the App's launch-time
// locate finishes before the sign-in is restored, and is sent once per position and token.
import assert from 'node:assert/strict';
import { createLocationReporter } from '../../../src/map/locationReport.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sent = [];
let fail = false;
const reporter = createLocationReporter(async (backendUrl, token, position) => {
    sent.push({ backendUrl, token, ...position });
    if (fail) throw new Error('offline');
});
const signedIn = (token) => ({ isAuthenticated: true, token, backendUrl: 'https://api.test' });
const originalWarn = console.warn;
console.warn = () => {};

try {
    // Launch: located while still signed out, then the stored sign-in comes back.
    reporter.located({ lat: 23.05, lng: 113.4, accuracy: 30 });
    await flush();
    assert.deepEqual(sent, [], 'nothing is sent while signed out');
    reporter.setAuth(signedIn('t1'));
    await flush();
    assert.deepEqual(sent, [{ backendUrl: 'https://api.test', token: 't1', lat: 23.05, lng: 113.4 }]);

    // Same position, same token: sent once; a new fix is sent again.
    reporter.setAuth(signedIn('t1'));
    await flush();
    assert.equal(sent.length, 1);
    reporter.located({ lat: 23.06, lng: 113.41 });
    await flush();
    assert.deepEqual(sent.at(-1), { backendUrl: 'https://api.test', token: 't1', lat: 23.06, lng: 113.41 });

    // Another account on the same device gets the current position too.
    reporter.setAuth(signedIn('t2'));
    await flush();
    assert.equal(sent.at(-1).token, 't2');

    // A failed report is retried on the next sign-in change.
    fail = true;
    reporter.located({ lat: 23.07, lng: 113.42 });
    await flush();
    const failedCount = sent.length;
    fail = false;
    reporter.setAuth(signedIn('t2'));
    await flush();
    assert.equal(sent.length, failedCount + 1, 'retried after a failure');

    // Signed out or invalid fixes: nothing.
    reporter.setAuth({ isAuthenticated: false, token: null, backendUrl: 'https://api.test' });
    reporter.located({ lat: 23.08, lng: 113.43 });
    reporter.located({ lat: NaN, lng: 113 });
    await flush();
    assert.equal(sent.length, failedCount + 1);
} finally {
    console.warn = originalWarn;
}
console.log('location report tests passed');
