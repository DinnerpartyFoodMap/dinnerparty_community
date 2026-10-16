const { db, isVectorSearchAvailable } = require('../../../infrastructure/database');
const botConfig = require('./config');
const { nearbyCandidates, drawRecommendation, personalizeCandidates } = require('../../discovery/services/randomRecommendation');
const { getUserPreference } = require('../../preferences/services/userPreferenceService');
const { getUserLocation } = require('../../accounts/services/userLocation');
const { resolveQQUser } = require('./qqIdentity');

// !随机: the website's random pick (5 km circle, same weights, personalised for
// accounts with a taste profile). The centre is the account's last located
// position (map locate button or a QQ location card), else the configured default.
const RECENT_TTL_MS = 60 * 60 * 1000;
const recentPicks = new Map();

function recentIds(qq, now) {
    const entry = recentPicks.get(qq);
    if (!entry) return [];
    if (now - entry.at > RECENT_TTL_MS) {
        recentPicks.delete(qq);
        return [];
    }
    return entry.ids;
}

function remember(qq, placeId, now) {
    if (recentPicks.size > 2000) {
        for (const [key, entry] of recentPicks) if (now - entry.at > RECENT_TTL_MS) recentPicks.delete(key);
    }
    // Like the website, the last two picks are skipped on the next draw.
    recentPicks.set(qq, { ids: recentIds(qq, now).concat(placeId).slice(-2), at: now });
}

function pickRandomPlace(ctx, { random = Math.random } = {}) {
    const config = botConfig.get();
    const identity = resolveQQUser(ctx.senderQq);
    // A restricted account may still browse; only an unambiguous account counts.
    const user = identity.user && (identity.status === 'ok' || identity.status === 'banned') ? identity.user : null;
    const saved = user ? getUserLocation(user.id) : null;
    const center = saved ? { lat: saved.lat, lng: saved.lng } : config.random.center;
    const now = ctx.now.getTime();
    const personalize = user && isVectorSearchAvailable() ? (candidates) => {
        try {
            return personalizeCandidates(db._raw, candidates, getUserPreference(user.id));
        } catch (_) {
            return { candidates, personalized: false };
        }
    } : null;
    const result = drawRecommendation(nearbyCandidates(db._raw, center), recentIds(ctx.senderQq, now), random, personalize);
    if (result.place) remember(ctx.senderQq, result.place.id, now);
    return {
        ...result,
        center,
        centerSource: saved ? 'user' : 'default',
        centerLabel: saved ? saved.label : config.random.centerName,
        registered: !!user
    };
}

module.exports = { pickRandomPlace, _resetForTesting: () => recentPicks.clear() };
