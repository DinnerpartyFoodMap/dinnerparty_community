import assert from 'node:assert/strict';
import {
    PRIVACY_CONSENT_KEY, PRIVACY_POLICY_VERSION, parsePrivacyConsent,
    readPrivacyConsent, rememberPrivacyChoice
} from '../../../src/platform/privacyConsent.js';
import { loadAmap } from '../../../src/platform/amapLoader.js';

const values = new Map();
let storageBlocked = false;
globalThis.window = {
    localStorage: {
        getItem(key) { if (storageBlocked) throw new Error('blocked'); return values.get(key) ?? null; },
        setItem(key, value) { if (storageBlocked) throw new Error('blocked'); values.set(key, value); }
    },
    AMap: { existingSdk: true }
};

for (const raw of [null, '', 'broken', '{}', 'true', JSON.stringify({ version: 'old', decision: 'accepted' }),
    JSON.stringify({ version: PRIVACY_POLICY_VERSION, decision: 'invalid' })]) {
    assert.equal(parsePrivacyConsent(raw), 'pending', 'missing, invalid or older consent requires a new decision');
}
assert.equal(readPrivacyConsent(), 'pending');
await assert.rejects(loadAmap(), { code: 'PRIVACY_CONSENT_REQUIRED' }, 'an existing SDK must not bypass consent');

values.set(PRIVACY_CONSENT_KEY, JSON.stringify({ version: PRIVACY_POLICY_VERSION, decision: 'rejected' }));
assert.equal(readPrivacyConsent(), 'rejected', 'a saved rejection must survive a reload');
await assert.rejects(loadAmap(), { code: 'PRIVACY_CONSENT_REQUIRED' });

assert.equal(rememberPrivacyChoice('accepted'), true);
assert.equal(readPrivacyConsent(), 'accepted');
assert.equal(JSON.parse(values.get(PRIVACY_CONSENT_KEY)).version, PRIVACY_POLICY_VERSION);
assert.equal(await loadAmap(), window.AMap, 'the SDK becomes available only after agreement');

storageBlocked = true;
assert.equal(rememberPrivacyChoice('rejected'), false, 'blocked storage must not crash the choice flow');
assert.equal(readPrivacyConsent(), 'rejected', 'the latest choice remains effective in memory');
await assert.rejects(loadAmap(), { code: 'PRIVACY_CONSENT_REQUIRED' });
assert.equal(rememberPrivacyChoice('accepted'), false);
assert.equal(readPrivacyConsent(), 'accepted', 'agreement may apply to this launch without persistent storage');
assert.throws(() => rememberPrivacyChoice('pending'), /Invalid privacy decision/);
delete globalThis.window;
console.log('Privacy consent passed: invalid and old records, saved refusal, SDK guard and unavailable storage.');
