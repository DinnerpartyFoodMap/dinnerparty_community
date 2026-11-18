const { db } = require('../../../infrastructure/database');

const CHECK_IN_COUNT_SQL = `(SELECT COUNT(*) FROM PlaceCheckIn c JOIN User cu ON cu.id=c.user_id
    WHERE c.place_id=p.id AND COALESCE(cu.is_banned,0)=0) AS checkin_count`;

function ratingKey(placeId, userId) {
    return JSON.stringify([placeId, userId]);
}

function checkInWeights(database = db._raw) {
    const rows = database.prepare(`
        SELECT c.place_id,c.user_id,COUNT(*) AS visits,
            MAX(CASE WHEN c.rating_revision=s.revision THEN c.description_approved+c.photos_approved ELSE 0 END) AS completeness
        FROM PlaceCheckIn c LEFT JOIN RatingStream s ON s.place_id=c.place_id AND s.user_id=c.user_id
        GROUP BY c.place_id,c.user_id
    `).all();
    return new Map(rows.map(row => [ratingKey(row.place_id, row.user_id), row]));
}

function checkInMultiplier(weights, placeId, userId, keepCompleteness = true) {
    const result = weights.get(ratingKey(placeId, userId));
    if (!result) return 1;
    return (100 + Math.min(result.visits, 3) * 5 + (keepCompleteness ? result.completeness * 10 : 0)) / 100;
}

module.exports = { CHECK_IN_COUNT_SQL, checkInWeights, checkInMultiplier };
