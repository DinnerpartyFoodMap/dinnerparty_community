import assert from 'node:assert/strict';
import { submitCheckIn } from '../../../src/places/checkInSubmission.js';

const fix = { lat: 0, lng: 110, timestamp: 1234.5 };
const calls = [];
const locate = async () => { calls.push('locate'); return fix; };
const saved = { ok: true, body: { id: 'saved', rating_saved: false } };
const received = await submitCheckIn({ retry: true, locate, send: async location => {
    calls.push(location);
    return saved;
} });
assert.deepEqual(calls, [undefined]);
assert.equal(received, saved);

calls.length = 0;
const missingLocation = { ok: false, body: { code: 'CHECK_IN_LOCATION_INVALID' } };
await submitCheckIn({ retry: true, locate, send: async location => {
    calls.push(location);
    return location ? saved : missingLocation;
} });
assert.deepEqual(calls, [undefined, 'locate', fix]);

calls.length = 0;
const unrelatedError = { ok: false, body: { code: 'CHECK_IN_QUOTA' } };
assert.equal(await submitCheckIn({ retry: true, locate, send: async location => {
    calls.push(location);
    return unrelatedError;
} }), unrelatedError);
assert.deepEqual(calls, [undefined], 'other responses are returned without a location prompt');

calls.length = 0;
assert.equal(await submitCheckIn({ retry: true, hasReceipt: true, locate, send: async location => {
    calls.push(location);
    return missingLocation;
} }), missingLocation);
assert.deepEqual(calls, [undefined], 'a score-only retry never reacquires location');

calls.length = 0;
await submitCheckIn({ retry: false, locate, send: async location => {
    calls.push(location);
    return saved;
} });
assert.deepEqual(calls, ['locate', fix]);
console.log('Check-in replays request before location and preserves score-only retry');
