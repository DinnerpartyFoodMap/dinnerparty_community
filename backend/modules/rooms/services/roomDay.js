const { beijingClock, dayAt, daysBefore, currentMinute } = require('../../../infrastructure/beijingClock');
const { getCompanionState } = require('../../skins/services/companionState');
const { publicPlaceSql } = require('../../places/services/placeVisibility');
const { storedClasses } = require('../../preferences/services/tasteAxes');
const { awakeWindow, simulateDay, renderEvent, soloMeal } = require('./roomSimulator');
const { loadOutingContext, planSoloOutings, outingPlace, recentPlaceIds } = require('./roomOutings');
const { loadCorpus } = require('./roomCorpus');
const { renderMeet, renderMeetText, isDinnerMeet } = require('./roomScripts');
const { RoomError, roomNotFound } = require('./roomErrors');
const { canReadRoom, canDisclose, readRoom, isNamed, isPaused, roomPerson, markVisit } = require('./roomAccess');
const { bondLevel, readBond, readMeet } = require('./roomMeets');

const MOMENT_LIMIT = 200;
const PAGE_SIZE = 30;
const MOMENT_ORDER = 'day DESC, t DESC, id DESC';
const outingId = (event) => event.outing?.id;

function readDay(database, userId, day) {
    return database.prepare('SELECT * FROM RoomDay WHERE user_id = ? AND day = ?').get(userId, day);
}

function readOutings(database, userId, day) {
    const rows = database.prepare(`SELECT o.*, p.name, p.category, p.description FROM RoomOuting o
        JOIN Place p ON p.id = o.place_id WHERE o.user_id = ? AND o.day = ?
        ORDER BY o.start_min, o.id`).all(userId, day);
    if (!rows.length) return [];
    const classes = storedClasses(database);
    return rows.map(({ name, category, description, ...row }) => ({
        ...row, place: outingPlace({ id: row.place_id, name, category, description }, classes.get(row.place_id))
    }));
}

function planOutings(database, { userId, day, sheet, city, corpus, kept, notBefore, meet }) {
    if (!city) return [];
    const { candidates, personalize } = loadOutingContext(database, userId, { city });
    const lead = outingMinutes(corpus, 'pick') + outingMinutes(corpus, 'leave');
    const reserved = meet?.kind === 'remote' ? [{
        start_min: meet.start_min - outingMinutes(corpus, 'back'), end_min: meet.end_min + lead
    }] : [];
    // 隔空剧情写的是在家吃晚饭时，这天不再出门吃晚饭
    const takenSlots = meet?.kind === 'remote' && isDinnerMeet(meet, corpus) ? ['dinner'] : [];
    const planned = planSoloOutings({
        userId, day, sheet, ...awakeWindow({ userId, day, sheet }), candidates, personalize, takenSlots,
        recentPlaceIds: recentPlaceIds(database, userId, day), existingOutings: kept, notBefore: notBefore + lead, reserved
    });
    const insert = database.prepare(`INSERT INTO RoomOuting (user_id, day, slot, place_id, start_min, end_min, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`);
    return planned.map((outing) => {
        const { slot, place, start_min, end_min, reason } = outing;
        const { id } = insert.get(userId, day, slot, place.id, start_min, end_min, reason);
        return { ...outing, id };
    });
}

function outingMinutes(corpus, step) {
    return corpus.situations.find((situation) => situation.step === step)?.minutes[1] ?? 0;
}

function scheduleCutoff(database, userId, day, minute) {
    const stored = readDay(database, userId, day);
    const events = stored ? JSON.parse(stored.events) : [];
    const started = events.filter(({ start_min }) => start_min <= minute);
    const ids = new Set(started.map(outingId).filter((id) => id != null));
    return Math.max(minute + 1, ...events.filter((event) => event.start_min <= minute || ids.has(outingId(event)))
        .map(({ end_min }) => end_min));
}

function generateDay(database, { userId, day, profile, sheet, clock, now, corpus, stored, scheduled = false }) {
    const firstDayStart = day === profile.named_day && profile.named_at_ms != null
        ? currentMinute(beijingClock(new Date(profile.named_at_ms))) + 1 : 0;
    const minute = scheduled && day !== clock.day ? -1 : currentMinute(clock) + (day < clock.day ? 1440 : 0);
    const fromMin = stored ? Math.max(firstDayStart, minute + 1) : firstDayStart;
    const previous = stored ? JSON.parse(stored.events) : [];
    const started = previous.filter(({ start_min }) => start_min < fromMin);
    const startedOutings = new Set(started.map(outingId).filter((id) => id != null));
    const outings = readOutings(database, userId, day);
    const replan = scheduled || stored && stored.city !== profile.city;
    const keepUntil = scheduled ? Math.max(fromMin, minute + 1) : fromMin;
    const kept = replan ? outings.filter((outing) => outing.reason === 'meet'
        || outing.start_min < keepUntil || startedOutings.has(outing.id)) : outings;
    if (replan) {
        const keptIds = new Set(kept.map(({ id }) => id));
        const remove = database.prepare('DELETE FROM RoomOuting WHERE id = ?');
        for (const { id } of outings) if (!keptIds.has(id)) remove.run(id);
    }
    const outingById = new Map(kept.map((outing) => [outing.id, outing]));
    const continuing = previous.filter((event) => event.start_min >= fromMin
        && (event.meet_id != null || startedOutings.has(outingId(event)) || outingById.has(outingId(event))))
        .map((event) => ({ event, outing: outingById.get(outingId(event)) }));
    const fixedOutings = new Set([...startedOutings, ...continuing.map(({ event }) => outingId(event))]);
    const meet = readMeet(database, userId, day);
    const meetRepresented = [...started, ...continuing.map(({ event }) => event)]
        .some((event) => event.type === 'meet' && event.meet_id === meet?.id);
    const newOutings = replan || !stored && !outings.length
        ? planOutings(database, { userId, day, sheet, city: profile.city, corpus, kept, meet,
            notBefore: Math.max(keepUntil, ...started.map(({ end_min }) => end_min)) })
        : [];
    const recent = database.prepare('SELECT used FROM RoomDay WHERE user_id = ? AND day >= ? AND day < ?')
        .all(userId, daysBefore(day, 3), day).flatMap(({ used }) => JSON.parse(used));
    const result = simulateDay({
        userId, day, sheet, corpus, recent, locked: started, continuing, fromMin,
        outings: [...kept, ...newOutings].filter(({ id }) => !fixedOutings.has(id)),
        meets: meet && !meetRepresented ? [meet] : []
    });
    const represented = new Set(result.events.map(outingId));
    const removeUnused = database.prepare("DELETE FROM RoomOuting WHERE id = ? AND reason IN ('solo', 'explore')");
    for (const { id } of [...kept, ...newOutings]) if (!represented.has(id)) removeUnused.run(id);
    result.events = result.events.map((event) => ({
        ...event, outing: outingId(event) == null ? null : { id: outingId(event) }
    }));
    database.prepare(`INSERT INTO RoomDay
        (user_id, day, sheet_hash, city, corpus_version, events, used, wake_min, sleep_min, generated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET sheet_hash = excluded.sheet_hash, city = excluded.city,
        corpus_version = excluded.corpus_version, events = excluded.events, used = excluded.used,
        wake_min = excluded.wake_min, sleep_min = excluded.sleep_min, generated_at_ms = excluded.generated_at_ms`)
        .run(userId, day, profile.sheet_hash, profile.city, result.corpus_version, JSON.stringify(result.events),
            JSON.stringify(result.used), result.wake_min, result.sleep_min, Number(now));
    return result.events;
}

function refreshToday(database, { userId, profile, sheet, clock, now, corpus }) {
    const stored = readDay(database, userId, clock.day);
    if (stored) generateDay(database, { userId, day: clock.day, profile, sheet, clock, now, corpus, stored });
}

function friendsOf(database, ownerId, now) {
    const bonds = database.prepare(`SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END AS partner, score
        FROM RoomBond WHERE (user_low = ? OR user_high = ?) AND score >= 4
        ORDER BY score DESC, partner`).all(ownerId, ownerId, ownerId);
    const friends = [];
    for (const { partner, score } of bonds) {
        const room = readRoom(database, partner);
        if (!canDisclose(database, room, ownerId, now)) continue;
        const { user_id, name, avatar } = roomPerson(database, room, ownerId);
        friends.push({ user_id, name, avatar, level: bondLevel(score) });
        if (friends.length === 3) break;
    }
    return friends;
}

function presentation(database, { viewerId, ownerId, person, now, corpus }) {
    const people = new Map([[ownerId, person]]);
    const anchors = new Map(corpus.situations.filter(({ anchor }) => anchor).map(({ id, anchor }) => [id, anchor]));
    const sayings = viewerId === ownerId ? null : new Set(database.prepare(`SELECT value FROM RoomText
        WHERE user_id = ? AND status = 'visible' AND substr(field, 1, 7) = 'saying:'`)
        .all(ownerId).map(({ value }) => `「${value}」`));
    const meetings = new Map();
    const readMeeting = database.prepare('SELECT * FROM RoomMeet WHERE id = ?');
    const readPlace = database.prepare(`SELECT id, name, description, category FROM Place p WHERE p.id = ? AND ${publicPlaceSql('p')}`);

    function story(id, place) {
        if (meetings.has(id)) return meetings.get(id);
        const meet = readMeeting.get(id);
        let result = null;
        if (meet && (meet.x_user === ownerId || meet.y_user === ownerId)) {
            const partnerId = meet.x_user === ownerId ? meet.y_user : meet.x_user;
            const room = readRoom(database, partnerId);
            if ((meet.place_id == null || place?.id === meet.place_id) && canDisclose(database, room, ownerId, now)
                && (viewerId === ownerId || canDisclose(database, room, viewerId, now))) {
                const partner = roomPerson(database, room, viewerId);
                const sameName = person.name === partner.name;
                const name = (entry) => sameName ? `${entry.owner_name}的${entry.name}` : entry.name;
                const x = meet.x_user === ownerId ? name(person) : name(partner);
                const y = meet.x_user === ownerId ? name(partner) : name(person);
                const group = { kind: meet.kind, id, place, partner: { user_id: partnerId, name: name(partner) } };
                const render = (event) => {
                    const { start_min, end_min, type, icon, star } = event;
                    const swap = type === 'bond' && meet.bond_swap;
                    return { start_min, end_min, type, icon, star: star ? type : null, who: [meet.x_user, meet.y_user],
                        ...renderMeetText(event, { x: swap ? y : x, y: swap ? x : y, place: place?.name }),
                        saying: false, quirk: null, anchor: null, place, group };
                };
                result = { meet, partner, group, render, beats: renderMeet(meet, corpus) };
            }
        }
        meetings.set(id, result);
        return result;
    }

    function solo(event, place, group) {
        const { start_min, end_min, type, icon, star, quirk } = event;
        const lines = renderEvent(event, { name: person.name, places: { [event.place_id]: place?.name } });
        const saying = Boolean(event.saying && (!sayings || sayings.has(event.sound)));
        if (event.saying && !saying) lines.sound = null;
        return { start_min, end_min, type, who: [ownerId], icon, ...lines, star, saying, quirk, place,
            anchor: anchors.get(event.sid) ?? null, group: group ??
                (outingId(event) == null ? null : { kind: 'outing', id: outingId(event), place }) };
    }

    const places = new Map();
    function placeRow(id) {
        if (!places.has(id)) places.set(id, readPlace.get(id));
        return places.get(id);
    }
    return { people, placeRow, story, solo };
}

function expandTimeline(database, events, { day, ownerId, sheet, corpus, view }) {
    let classes;
    return events.flatMap((event) => {
        const row = event.place_id == null ? null : view.placeRow(event.place_id);
        if (event.place_id != null && !row) return [];
        const place = row ? { id: row.id, name: row.name } : null;
        const story = event.meet_id == null ? null : view.story(event.meet_id, place);
        if (event.type !== 'meet') return [{ event: view.solo(event, place, story?.group), template: event, story }];
        const meal = (window, group) => {
            classes ??= storedClasses(database);
            return soloMeal({ userId: ownerId, day, sheet, event: { ...event, ...window }, place: outingPlace(row, classes.get(row.id)),
                corpus, shared: !!group }).map((fallback) => ({ event: view.solo(fallback, place, group) }));
        };
        if (story?.beats.length) {
            const beats = story.beats.map((beat) => ({ event: story.render(beat), story, template: beat }));
            // 剧本写的是饭后或最后几口时，前面那段是自己点单、吃饭
            const first = story.beats[0].start_min;
            return row && first > event.start_min
                ? [...meal({ start_min: event.start_min, end_min: first }, story.group), ...beats] : beats;
        }
        if (!row) return [];
        return meal({}, undefined);
    }).sort((a, b) => a.event.start_min - b.event.start_min);
}

function saveMoments(database, ownerId, day, started, now) {
    const toSave = [];
    const stories = new Set();
    for (const { event, template, story } of started) {
        if (story && event.type === 'meet') stories.add(story);
        else if (event.star === 'explore' || event.star === 'rare') toSave.push({ userId: ownerId, kind: event.star, template });
    }
    for (const { meet, beats } of stories) {
        for (const beat of beats.filter(({ star }) => star)) {
            for (const userId of [meet.x_user, meet.y_user]) {
                toSave.push({ userId, kind: beat.type, template: beat, meetId: meet.id, placeId: meet.place_id });
            }
        }
    }
    if (!toSave.length) return;
    const insert = database.prepare(`INSERT INTO RoomMoment (user_id, day, t, kind, event, meet_id, place_id, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, day, t, kind) DO NOTHING`);
    const oldest = database.prepare(`SELECT day, t FROM RoomMoment WHERE user_id = ? ORDER BY ${MOMENT_ORDER} LIMIT 1 OFFSET ?`);
    const added = new Set();
    for (const { userId, kind, template, meetId = null, placeId = template.place_id ?? null } of toSave) {
        const cutoff = oldest.get(userId, MOMENT_LIMIT - 1);
        const t = template.start_min;
        if (cutoff && (day < cutoff.day || day === cutoff.day && t < cutoff.t)) continue;
        if (insert.run(userId, day, t, kind, JSON.stringify(template), meetId, placeId, Number(now)).changes) added.add(userId);
    }
    const trim = database.prepare(`DELETE FROM RoomMoment WHERE id IN (
        SELECT id FROM RoomMoment WHERE user_id = ? ORDER BY ${MOMENT_ORDER} LIMIT -1 OFFSET ?
    )`);
    for (const userId of added) trim.run(userId, MOMENT_LIMIT);
}

function getDay(database, { viewerId, ownerId, day, now = Date.now() }) {
    if (!viewerId) throw roomNotFound();
    const clock = beijingClock(new Date(now));
    const own = viewerId === ownerId;
    return database.transaction(() => {
        const profile = readRoom(database, ownerId);
        if (!own && !canReadRoom(database, viewerId, ownerId, now, profile)) throw roomNotFound();
        if (!isNamed(profile)) return { named: false };
        const sheet = JSON.parse(profile.sheet);
        const yesterday = daysBefore(clock.day, 1);
        const minute = currentMinute(clock);
        const wake = readDay(database, ownerId, clock.day)?.wake_min ?? awakeWindow({ userId: ownerId, day: clock.day, sheet }).wake_min;
        const overnight = minute < wake && readDay(database, ownerId, yesterday)?.sleep_min > minute + 1440;
        if (day === undefined) day = overnight ? yesterday : clock.day;
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
            || !Number.isFinite(Date.parse(day)) || dayAt(Date.parse(day)) !== day
            || day < profile.named_day || day < daysBefore(clock.day, 30) || day > clock.day) {
            throw new RoomError(400, 'room_invalid_day', '日期须在入住日到今天之间，且限近 30 天');
        }
        const corpus = loadCorpus();
        const isToday = day === clock.day || overnight && day === yesterday;
        const paused = isPaused(profile.map_settings);
        const state = getCompanionState(ownerId, database);
        const person = roomPerson(database, profile, viewerId, sheet, state);
        const quirks = sheet.quirks.flatMap((id) => {
            const quirk = corpus.quirks.find((entry) => entry.id === id);
            return quirk ? [{ id, name: quirk.name }] : [];
        });
        markVisit(database, ownerId, own, now);
        const score = own ? null : readBond(database, viewerId, ownerId);
        const owner = { ...person, tags: sheet.tags, quirks, ...(own
            ? { satiety: state.satiety, friends: friendsOf(database, ownerId, now) }
            : { bond_level: score == null ? null : bondLevel(score) }) };
        const response = { named: true, paused, day, is_today: isToday, first_day: profile.named_day, next_at: null,
            owner, events: [], people: [person] };
        if (paused) return response;
        const stored = readDay(database, ownerId, day);
        const templates = !stored || isToday && (stored.sheet_hash !== profile.sheet_hash || stored.city !== profile.city)
            ? generateDay(database, { userId: ownerId, day, profile, sheet, clock, now, corpus, stored })
            : JSON.parse(stored.events);
        const view = presentation(database, { viewerId, ownerId, now, person, corpus });
        const expanded = expandTimeline(database, templates, { day, ownerId, sheet, corpus, view });
        const at = isToday ? minute + (day === yesterday ? 1440 : 0) : Infinity;
        const started = expanded.filter(({ event }) => event.start_min <= at);
        response.next_at = expanded.find(({ event }) => event.start_min > at)?.event.start_min ?? null;
        response.events = started.map(({ event, story }) => {
            if (story) view.people.set(story.partner.user_id, story.partner);
            return event;
        });
        response.people = [...view.people.values()];
        saveMoments(database, ownerId, day, started, now);
        return response;
    }).immediate();
}

function getMoments(database, { viewerId, ownerId, before, now = Date.now() }) {
    if (!viewerId) throw roomNotFound();
    const own = viewerId === ownerId;
    const profile = readRoom(database, ownerId);
    if (!own && !canReadRoom(database, viewerId, ownerId, now, profile)) throw roomNotFound();
    if (!isNamed(profile)) return { moments: [], next_before: null };
    let cursor;
    if (before !== undefined) {
        if (!['string', 'number'].includes(typeof before) || !/^[1-9]\d*$/.test(String(before))
            || !Number.isSafeInteger(Number(before))) {
            throw new RoomError(400, 'room_invalid_cursor', '名场面的分页编号无效');
        }
        cursor = database.prepare('SELECT day, t, id FROM RoomMoment WHERE user_id = ? AND id = ?').get(ownerId, Number(before));
    }
    if (!own) markVisit(database, ownerId, false, now);
    if (before !== undefined && !cursor) return { moments: [], next_before: null };
    const clock = beijingClock(new Date(now));
    const rows = database.prepare(`SELECT m.*, p.name AS place_name FROM RoomMoment m
        LEFT JOIN Place p ON p.id = m.place_id AND ${publicPlaceSql('p')}
        WHERE m.user_id = ? AND (m.place_id IS NULL OR p.id IS NOT NULL)
        AND (m.day < ? OR (m.day = ? AND m.t <= ?))
        ${cursor ? 'AND (m.day, m.t, m.id) < (?, ?, ?)' : ''}
        ORDER BY m.${MOMENT_ORDER}`)
        .all(ownerId, clock.day, clock.day, currentMinute(clock), ...(cursor ? [cursor.day, cursor.t, cursor.id] : []));
    const person = roomPerson(database, profile, viewerId);
    const view = presentation(database, { viewerId, ownerId, person, now, corpus: loadCorpus() });
    const moments = [];
    for (const { id, day, t, kind, event, meet_id, place_id, place_name } of rows) {
        const place = place_id == null ? null : { id: place_id, name: place_name };
        const template = JSON.parse(event);
        const expanded = meet_id == null ? view.solo(template, place) : view.story(meet_id, place)?.render(template);
        if (expanded) moments.push({ id, day, t, kind, event: expanded });
        if (moments.length > PAGE_SIZE) break;
    }
    const hasMore = moments.length > PAGE_SIZE;
    if (hasMore) moments.pop();
    return { moments, next_before: hasMore ? moments.at(-1).id : null };
}

module.exports = { getDay, getMoments, refreshToday, generateDay, readDay, scheduleCutoff, outingMinutes };
