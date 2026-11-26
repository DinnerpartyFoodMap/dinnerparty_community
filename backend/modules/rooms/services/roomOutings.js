const { recommendationWeight, drawRecommendation, personalizeCandidates, placeVectorReader } = require('../../discovery/services/randomRecommendation');
const { publicPreference, isUsablePreference } = require('../../preferences/services/preferenceVectorProfile');
const { resolvePlaceAxes, storedClasses, hasVectorSearch } = require('../../preferences/services/tasteAxes');
const { publicPlaceSql } = require('../../places/services/placeVisibility');
const { isAvoidedPlace } = require('../../ratings/services/ratingWarning');
const { createRng } = require('./roomRandom');
const { cosine } = require('./roomPairing');
const { daysBefore } = require('../../../infrastructure/beijingClock');

const SETTINGS = Object.freeze({
    weekdayCounts: [0.45, 0.45, 0.1],
    weekendCounts: [0.25, 0.5, 0.25],
    homebodyReduction: 1,
    grid: 5,
    awakeMargin: 45,
    gap: 60,
    minCandidates: 5,
    explorationChance: 0.2,
    slots: {
        breakfast: { window: [420, 570], weight: 0.5 },
        lunch: { window: [690, 810], weight: 1 },
        tea: { window: [870, 990], weight: 0.6 },
        dinner: { window: [1050, 1200], weight: 1 },
        night: { window: [1290, 1440], weight: 0.4 }
    },
    nightWeight: 2,
    slotFactors: {
        drinks: { tea: 3 },
        dessert: { tea: 3 },
        hotpotBbq: { dinner: 3, night: 3, lunch: 0.3 },
        noodles: { breakfast: 2, lunch: 2, night: 2 },
        homestyle: { lunch: 2, dinner: 2 },
        foreign: { dinner: 2 }
    },
    minutes: { drinks: [30, 60], dessert: [30, 60], hotpotBbq: [80, 120], other: [40, 80] },
    lowRating: 2,
    spicy: /辣|川菜|湘菜|麻辣|串串|冒菜|钵钵鸡|重庆|贵州|螺蛳粉|酸菜鱼|水煮/u
});

const outingWeight = (place, slot) => recommendationWeight(place, 0) * (SETTINGS.slotFactors[place.axis]?.[slot] ?? 1);
const slotWindow = (slot) => SETTINGS.slots[slot].window;

function drawOutingPlace(candidates, slot, rng, personalize, eligible = () => true) {
    if (!candidates.some(eligible)) return null;
    const weighted = candidates.map((place) => ({
        place, distanceKm: 0,
        weight: outingWeight(place, slot)
    }));
    // Apply the room's longer cooldown after the recommendation pool's minimum-size check.
    const select = (pool) => {
        const remaining = pool.filter(({ place }) => eligible(place));
        return personalize ? personalize(remaining) : { candidates: remaining, personalized: false };
    };
    if (candidates.length < SETTINGS.minCandidates) {
        return rng.weighted(select(weighted).candidates, ({ weight }) => weight).place;
    }
    return drawRecommendation(weighted, [], rng.next, select).place;
}

const durationRange = (axis) => SETTINGS.minutes[axis] ?? SETTINGS.minutes.other;

function possibleTimes(window, wake, sleep, outings, notBefore) {
    const startAt = Math.max(window[0], wake + SETTINGS.awakeMargin, notBefore);
    const times = [];
    for (let start = Math.ceil(startAt / SETTINGS.grid) * SETTINGS.grid; start < window[1]; start += SETTINGS.grid) {
        let until = sleep - SETTINGS.awakeMargin;
        for (const outing of outings) {
            if (start >= outing.end_min + SETTINGS.gap) continue;
            until = Math.min(until, outing.start_min - SETTINGS.gap);
        }
        if (until > start) times.push({ start, available: until - start });
    }
    return times;
}

function planSoloOutings({ userId, day, sheet, wake_min, sleep_min, candidates, recentPlaceIds = [],
    takenSlots = [], personalize = null, notBefore = 0, existingOutings = [], reserved = [] }) {
    if (candidates.length < SETTINGS.minCandidates) return [];
    const rng = createRng(userId, day, 'room-outing-v1');
    const weekday = new Date(day).getUTCDay();
    const odds = weekday === 0 || weekday >= 5 ? SETTINGS.weekendCounts : SETTINGS.weekdayCounts;
    const count = rng.weighted(odds.map((weight, n) => ({ n, weight })), ({ weight }) => weight).n;
    const usedSlots = new Set([...takenSlots, ...existingOutings.map(({ slot }) => slot)]);
    const desired = count - usedSlots.size - (sheet.tags.includes('宅') ? SETTINGS.homebodyReduction : 0);
    const excluded = new Set(Array.from(recentPlaceIds, String));
    for (const { place_id } of existingOutings) excluded.add(String(place_id));
    const fresh = candidates.filter((place) => !place.rated && !place.favorited);
    const outings = [];

    while (outings.length < desired) {
        const explore = fresh.length >= SETTINGS.minCandidates && rng.chance(SETTINGS.explorationChance);
        const slots = Object.entries(SETTINGS.slots).flatMap(([slot, { weight, window }]) => {
            if (usedSlots.has(slot) || slot === 'breakfast' && !sheet.tags.includes('早起')) return [];
            const times = possibleTimes(window, wake_min, sleep_min, [...existingOutings, ...outings], notBefore)
                .flatMap(({ start, available }) => {
                    for (const block of reserved) {
                        if (start >= block.end_min) continue;
                        available = Math.min(available, block.start_min - start);
                    }
                    return available > 0 ? [{ start, available }] : [];
                });
            const longest = Math.max(0, ...times.map(({ available }) => available));
            const eligible = (place) => !excluded.has(String(place.id)) && durationRange(place.axis)[0] <= longest;
            if (!candidates.some(eligible)) return [];
            const nightOwl = slot === 'night' && (sheet.tags.includes('夜宵党') || sheet.tags.includes('夜猫子'));
            return [{ slot, weight: weight * (nightOwl ? SETTINGS.nightWeight : 1), times, eligible }];
        });
        const exploreSlots = explore ? slots.filter(({ eligible }) => fresh.some(eligible)) : [];
        const exploring = exploreSlots.length > 0;
        const chosen = rng.weighted(exploring ? exploreSlots : slots, ({ weight }) => weight);
        if (!chosen) break;
        const { slot, times, eligible } = chosen;
        const place = drawOutingPlace(exploring ? fresh : candidates, slot, rng, personalize, eligible);
        const [min, max] = durationRange(place.axis);
        const { start, available } = rng.pick(times.filter((time) => time.available >= min));
        outings.push({ slot, start_min: start, end_min: start + rng.int(min, Math.min(max, available)),
            reason: exploring ? 'explore' : 'solo', place });
        usedSlots.add(slot);
        excluded.add(String(place.id));
    }
    return outings.sort((a, b) => a.start_min - b.start_min);
}

function readOutingPreference(row) {
    const preference = publicPreference(row);
    return isUsablePreference(preference) ? preference : null;
}

function outingPlace(place, storedClass) {
    return {
        ...place,
        axis: resolvePlaceAxes(place, storedClass).axes[0] ?? null,
        spicy: SETTINGS.spicy.test(`${place.name} ${place.category ?? ''}`)
    };
}

function loadOutingContext(database, userId, { city } = {}) {
    if (city === undefined) city = database.prepare('SELECT city FROM UserLastLocation WHERE user_id = ?').get(userId)?.city || null;
    const preference = readOutingPreference(database.prepare('SELECT * FROM UserPreference WHERE user_id = ?').get(userId));
    if (!city) return { city, candidates: [], preference, personalize: null };

    const places = database.prepare(`SELECT p.id, p.name, p.description, p.category, p.per_person_cost,
        COALESCE(s.count, 0) AS rating_count, s.average AS rating_average,
        COALESCE(json_extract(s.distribution, '$."1"'), 0)
            + COALESCE(json_extract(s.distribution, '$."2"'), 0) AS rating_negative_count,
        (SELECT COUNT(DISTINCT f.user_id) FROM Favorite f WHERE f.place_id = p.id) AS favorite_count,
        r.score AS my_score,
        EXISTS (SELECT 1 FROM Favorite f WHERE f.place_id = p.id AND f.user_id = ?) AS favorited
        FROM PlaceRegion region JOIN Place p ON p.id = region.place_id
        LEFT JOIN PlaceRatingSummary s ON s.place_id = p.id
        LEFT JOIN PlaceRating r ON r.place_id = p.id AND r.user_id = ?
        WHERE region.city = ? AND ${publicPlaceSql('p')} ORDER BY p.id`).all(userId, userId, city);
    const classes = storedClasses(database);
    const candidates = places.flatMap(({ my_score, rating_count, rating_average, rating_negative_count, ...place }) => {
        if (isAvoidedPlace({ ...place, rating_count, rating_average, rating_negative_count })
            || my_score != null && my_score <= SETTINGS.lowRating) return [];
        return [outingPlace({
            ...place,
            rated: my_score != null,
            favorited: Boolean(place.favorited)
        }, classes.get(place.id))];
    });
    const personalize = preference && candidates.length && hasVectorSearch(database)
        ? (pool) => personalizeCandidates(database, pool, preference) : null;
    return { city, candidates, preference, personalize };
}

function recentPlaceIds(database, userId, day) {
    return database.prepare('SELECT DISTINCT place_id FROM RoomOuting WHERE user_id = ? AND day >= ? AND day < ?')
        .all(userId, daysBefore(day, 5), day).map(({ place_id }) => place_id);
}

function tablePlacePicker(database, a, b, day, rng) {
    const mine = loadOutingContext(database, a.userId, { city: a.city });
    const theirs = loadOutingContext(database, b.userId, { city: b.city });
    const shared = new Set(theirs.candidates.map(({ id }) => id));
    const excluded = new Set([...recentPlaceIds(database, a.userId, day), ...recentPlaceIds(database, b.userId, day)]);
    const candidates = mine.candidates.filter(({ id }) => shared.has(id) && !excluded.has(id));
    if (candidates.length < SETTINGS.minCandidates) return null;
    const readVector = (a.vector || b.vector) && hasVectorSearch(database) ? placeVectorReader(database) : () => null;
    const sim = (a, b) => Math.max(0, Math.min(1, cosine(a, b)));
    const weighted = candidates.map((place) => {
        const vector = readVector(place.id);
        return { place, tasteWeight: Math.exp(2 * sim(a.vector, vector) + 2 * sim(b.vector, vector)) };
    });
    return (slot) => rng.weighted(weighted, ({ place, tasteWeight }) => tasteWeight * outingWeight(place, slot)).place;
}

module.exports = { planSoloOutings, loadOutingContext, drawOutingPlace, readOutingPreference, outingPlace,
    recentPlaceIds, slotWindow, tablePlacePicker, durationRange };
