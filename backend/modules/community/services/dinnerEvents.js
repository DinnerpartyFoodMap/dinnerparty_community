const ended = `(LOWER(COALESCE(NULLIF(d.status, ''), 'open')) <> 'open'
    OR COALESCE(julianday(d.start_time) <= julianday('now'), 0))`;

const selection = `SELECT d.*, u.username AS creator_name, ${ended} AS is_ended,
    1 + (SELECT COUNT(*) FROM DinnerParticipant p WHERE p.dinner_id = d.id) AS participant_count
    FROM DinnerEvent d LEFT JOIN User u ON u.id = d.creator_id`;

function initDinnerParticipationSchema(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS DinnerParticipant (
        dinner_id INTEGER NOT NULL REFERENCES DinnerEvent(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        PRIMARY KEY (dinner_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dinner_participant_user ON DinnerParticipant(user_id);
    CREATE TABLE IF NOT EXISTS DinnerProposal (
        dinner_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        places TEXT NOT NULL,
        times TEXT NOT NULL,
        PRIMARY KEY (dinner_id, user_id),
        FOREIGN KEY (dinner_id, user_id) REFERENCES DinnerParticipant(dinner_id, user_id) ON DELETE CASCADE
    );`);
}

function serialize(row) {
    return {
        ...row,
        place_name: row.place_name || null,
        start_time: row.start_time || null,
        is_ended: Boolean(row.is_ended)
    };
}

function listDinners(sql, { query, includeEnded, offset }) {
    return sql.prepare(`${selection}
        WHERE (? OR NOT ${ended})
          AND (? = '' OR instr(lower(d.title), ?) OR instr(lower(d.description), ?)
                      OR instr(lower(d.place_name), ?) OR instr(lower(u.username), ?))
        ORDER BY is_ended, CASE WHEN NOT is_ended THEN julianday(d.start_time) IS NULL END,
            CASE WHEN NOT is_ended THEN julianday(d.start_time) END,
            CASE WHEN is_ended THEN julianday(d.start_time) END DESC, d.id DESC
        LIMIT 50 OFFSET ?`).all(Number(includeEnded), query, query, query, query, query, offset).map(serialize);
}

function findDinner(sql, id) {
    return sql.prepare(`${selection} WHERE d.id = ?`).get(id);
}

function readProposal(row) {
    return { places: JSON.parse(row.places), times: JSON.parse(row.times) };
}

function isParticipant(sql, id, userId) {
    return !!sql.prepare('SELECT 1 FROM DinnerParticipant WHERE dinner_id = ? AND user_id = ?').get(id, userId);
}

function dinnerDetail(sql, id, userId) {
    const row = findDinner(sql, id);
    if (!row) return null;
    const detail = serialize(row);
    detail.is_organizer = userId != null && row.creator_id === userId;
    detail.is_joined = detail.is_organizer || (userId != null && isParticipant(sql, id, userId));
    if (detail.is_organizer) {
        detail.proposals = sql.prepare(`SELECT p.*, u.username AS proposer_name FROM DinnerProposal p
            JOIN User u ON u.id = p.user_id WHERE p.dinner_id = ? ORDER BY u.username, p.user_id`).all(id)
            .map(proposal => ({ proposer_name: proposal.proposer_name, ...readProposal(proposal) }));
    } else if (detail.is_joined) {
        const proposal = sql.prepare('SELECT places, times FROM DinnerProposal WHERE dinner_id = ? AND user_id = ?').get(id, userId);
        detail.my_proposal = proposal ? readProposal(proposal) : { places: [], times: [] };
    }
    return detail;
}

function changeDinner(sql, id, userId, change) {
    return sql.transaction(() => {
        const row = findDinner(sql, id);
        if (!row) return { status: 404, error: '聚餐活动不存在' };
        if (row.is_ended) return { status: 409, error: '聚餐活动已结束' };
        const error = change(row, row.creator_id === userId);
        return error || { detail: dinnerDetail(sql, id, userId) };
    }).immediate();
}

function setParticipation(sql, id, userId, joined) {
    return changeDinner(sql, id, userId, (row, organizer) => {
        if (organizer) return joined ? null : { status: 403, error: '发起人不能退出自己的聚餐' };
        if (!joined) {
            sql.prepare('DELETE FROM DinnerParticipant WHERE dinner_id = ? AND user_id = ?').run(id, userId);
        } else if (!isParticipant(sql, id, userId)) {
            if (row.max_participants != null && row.participant_count >= row.max_participants) {
                return { status: 409, error: '聚餐人数已满' };
            }
            sql.prepare('INSERT INTO DinnerParticipant (dinner_id, user_id) VALUES (?, ?)').run(id, userId);
        }
    });
}

function saveProposal(sql, id, userId, { places, times }) {
    return changeDinner(sql, id, userId, (_row, organizer) => {
        if (organizer || !isParticipant(sql, id, userId)) return { status: 403, error: '加入聚餐后才能提交提案' };
        if (!places.length && !times.length) {
            sql.prepare('DELETE FROM DinnerProposal WHERE dinner_id = ? AND user_id = ?').run(id, userId);
            return;
        }
        sql.prepare(`INSERT INTO DinnerProposal (dinner_id, user_id, places, times) VALUES (?, ?, ?, ?)
            ON CONFLICT (dinner_id, user_id) DO UPDATE SET places = excluded.places, times = excluded.times`)
            .run(id, userId, JSON.stringify(places), JSON.stringify(times));
    });
}

function setSchedule(sql, id, userId, { place, time }) {
    return changeDinner(sql, id, userId, (row, organizer) => {
        if (!organizer) return { status: 403, error: '只有聚餐发起人可以确定时间和地点' };
        sql.prepare('UPDATE DinnerEvent SET place_name = ?, start_time = ?, updated_time = CURRENT_TIMESTAMP WHERE id = ?')
            .run(place === undefined ? row.place_name : place, time === undefined ? row.start_time : time, id);
    });
}

module.exports = { initDinnerParticipationSchema, listDinners, dinnerDetail, setParticipation, saveProposal, setSchedule };
