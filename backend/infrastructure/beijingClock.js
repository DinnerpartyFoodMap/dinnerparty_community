const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS;

function beijingClock(now) {
    const shifted = now.getTime() + BEIJING_OFFSET_MS;
    return {
        day: new Date(shifted).toISOString().slice(0, 10),
        dayNumber: Math.floor(shifted / DAY_MS),
        msOfDay: ((shifted % DAY_MS) + DAY_MS) % DAY_MS
    };
}

const dayAt = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBefore = (day, n) => dayAt(Date.parse(day) - n * DAY_MS);
const currentMinute = (clock) => Math.floor(clock.msOfDay / MINUTE_MS);

module.exports = { beijingClock, DAY_MS, MINUTE_MS, dayAt, daysBefore, currentMinute };
