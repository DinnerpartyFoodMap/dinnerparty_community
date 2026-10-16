const { placeDetailCompleteness } = require('../../places/services/placeQuality');

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function timeDecay(updatedAt, now = Date.now()) {
    const days = Math.max(0, now - updatedAt) / DAY_MS;
    return 0.6 + 0.4 / Math.max(1, Math.log1p(days) / Math.log(31));
}

function hasImages(value) {
    try {
        const images = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(images) && images.some((image) => typeof image === 'string' && image.trim());
    } catch {
        return false;
    }
}

/** Pure, synchronous snapshot calculation. No persisted weights enter the iteration. */
function calculateReputations({ users, places, ratings, favorites, requests, similarity = () => 0 }, now = Date.now()) {
    const active = new Set(users.filter((user) => !user.is_banned).map((user) => user.id));
    const placeById = new Map(places.map((place) => [place.id, place]));
    const validRatings = ratings.filter((rating) => active.has(rating.user_id) && placeById.has(rating.place_id));
    const ratersByPlace = new Map();
    const fansByPlace = new Map();
    const othersRated = new Map();
    const approved = new Map();
    for (const rating of validRatings) {
        if (!ratersByPlace.has(rating.place_id)) ratersByPlace.set(rating.place_id, []);
        ratersByPlace.get(rating.place_id).push(rating);
        if (placeById.get(rating.place_id).creator_id !== rating.user_id) {
            if (!othersRated.has(rating.user_id)) othersRated.set(rating.user_id, new Set());
            othersRated.get(rating.user_id).add(rating.place_id);
        }
    }
    for (const favorite of favorites) {
        if (!active.has(favorite.user_id) || !placeById.has(favorite.place_id)) continue;
        if (!fansByPlace.has(favorite.place_id)) fansByPlace.set(favorite.place_id, new Set());
        fansByPlace.get(favorite.place_id).add(favorite.user_id);
    }
    for (const request of requests) {
        if (request.status === 'approved' && active.has(request.requester_id)) {
            approved.set(request.requester_id, (approved.get(request.requester_id) || 0) + 1);
        }
    }

    const contributions = new Map([...active].map((id) => [id,
        0.1 * Math.min(30, othersRated.get(id)?.size || 0) + 0.5 * Math.min(10, approved.get(id) || 0)]));
    for (const place of places) {
        if (!active.has(place.creator_id)) continue;
        const f = [...(fansByPlace.get(place.id) || [])].filter((id) => id !== place.creator_id).length;
        const m = (ratersByPlace.get(place.id) || []).filter((rater) => rater.user_id !== place.creator_id).length;
        const completeness = 0.8 * placeDetailCompleteness(place)
            + 0.2 * (hasImages(place.exterior_images) || hasImages(place.menu_images) ? 1 : 0);
        contributions.set(place.creator_id, contributions.get(place.creator_id)
            + 0.3 * completeness + 0.4 * f / (f + 5) + 0.3 * Math.log1p(m));
    }

    // Eligibility and taste/time factors are constant across the three rounds.
    const samples = new Map([...active].map((id) => [id, []]));
    for (const rating of validRatings) {
        if (rating.source !== 'user' || placeById.get(rating.place_id).creator_id === rating.user_id) continue;
        const peers = (ratersByPlace.get(rating.place_id) || [])
            .filter((peer) => peer.user_id !== rating.user_id && peer.source === 'user');
        if (peers.length < 2) continue;
        samples.get(rating.user_id).push({
            score: rating.score,
            confidence: peers.length / (peers.length + 2),
            peers: peers.map((peer) => ({
                user_id: peer.user_id, score: peer.score,
                factor: timeDecay(peer.updated_at, now) * Math.exp(3 * similarity(rating.user_id, peer.user_id))
            }))
        });
    }

    let result = new Map([...active].map((user_id) => {
        const contribution = contributions.get(user_id);
        const beta = 1 - 0.5 * Math.exp(-contribution / 5);
        return [user_id, { user_id, contribution, beta, gamma: 1, weight: beta }];
    }));
    for (let round = 0; round < 3; round += 1) {
        const next = new Map();
        for (const [id, previous] of result) {
            const evidence = samples.get(id).map((sample) => {
                let total = 0;
                let weightTotal = 0;
                for (const peer of sample.peers) {
                    const weight = result.get(peer.user_id).weight * peer.factor;
                    total += weight * peer.score;
                    weightTotal += weight;
                }
                return { delta: sample.score - total / weightTotal, confidence: sample.confidence };
            });
            const deltaTotal = evidence.reduce((sum, item) => sum + item.delta, 0);
            let confidenceTotal = 0;
            let agreementTotal = 0;
            for (const item of evidence) {
                const bias = clamp((deltaTotal - item.delta) / (evidence.length - 1 + 5), -1, 1);
                const residual = item.delta - bias;
                confidenceTotal += item.confidence;
                agreementTotal += item.confidence * Math.exp(-residual * residual / 2);
            }
            const agreement = (agreementTotal + 4) / (confidenceTotal + 5);
            const gamma = clamp((agreement / 0.8) ** 2, 0.4, 1.25);
            next.set(id, {
                ...previous, gamma, weight: previous.beta * gamma,
                evidence: confidenceTotal, rating_count: evidence.length, agreement
            });
        }
        result = next;
    }
    return result;
}

module.exports = { DAY_MS, timeDecay, calculateReputations };
