const { createHash } = require('node:crypto');

function createRng(...parts) {
    let state = createHash('sha256').update(parts.join('')).digest().readUInt32BE(0);

    function next() {
        state = (state + 0x6d2b79f5) >>> 0;
        let bits = Math.imul(state ^ (state >>> 15), state | 1);
        bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
        return ((bits ^ (bits >>> 14)) >>> 0) / 0x100000000;
    }

    const int = (min, max) => min + Math.floor(next() * (max - min + 1));
    const chance = (probability) => next() < probability;
    const pick = (list) => list.length ? list[int(0, list.length - 1)] : undefined;

    function weighted(list, weightOf) {
        const weights = list.map((item) => {
            const weight = weightOf(item);
            return Number.isFinite(weight) && weight > 0 ? weight : 0;
        });
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        if (!total) return null;
        let ticket = next() * total;
        let last;
        for (const [index, weight] of weights.entries()) {
            if (!weight) continue;
            last = list[index];
            ticket -= weight;
            if (ticket < 0) return last;
        }
        return last;
    }

    function shuffle(list) {
        const result = [...list];
        for (let index = result.length - 1; index > 0; index -= 1) {
            const other = int(0, index);
            [result[index], result[other]] = [result[other], result[index]];
        }
        return result;
    }

    return { next, int, chance, pick, weighted, shuffle };
}

module.exports = { createRng };
