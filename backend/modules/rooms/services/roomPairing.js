const { createRng } = require('./roomRandom');

const SETTINGS = Object.freeze({ weekdayChance: 0.5, weekendChance: 0.7, baseWeight: 0.2, remoteWeight: 0.5 });

function cosine(a, b) {
    if (!a?.length || a.length !== b?.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] ** 2;
        normB += b[i] ** 2;
    }
    const similarity = dot / Math.sqrt(normA * normB);
    return Number.isFinite(similarity) ? similarity : 0;
}

function pairRooms({ rooms, day, rng = createRng(day, 'room-pair-v1'), eligible = () => true, level = () => 0 }) {
    const weekday = new Date(day).getUTCDay();
    const lively = weekday === 0 || weekday >= 5;
    const willing = rng.shuffle(rooms.filter(() => rng.chance(lively ? SETTINGS.weekendChance : SETTINGS.weekdayChance)));
    const pairs = [];
    while (willing.length > 1) {
        const a = willing.shift();
        const candidates = willing.filter((b) => eligible(a.userId, b.userId));
        if (!candidates.length) continue;
        const local = candidates.filter((b) => a.city && a.city === b.city);
        const kind = local.length ? 'table' : 'remote';
        const factor = local.length ? 1 : SETTINGS.remoteWeight;
        const b = rng.weighted(local.length ? local : candidates, (room) =>
            factor * (SETTINGS.baseWeight + Math.max(0, cosine(a.vector, room.vector))) * (1 + 0.5 * level(a.userId, room.userId)));
        willing.splice(willing.indexOf(b), 1);
        pairs.push({ a: a.userId, b: b.userId, kind });
    }
    return pairs;
}

module.exports = { pairRooms, cosine };
