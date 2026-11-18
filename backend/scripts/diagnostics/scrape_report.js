// 数据访问排查（防爬第 0 阶段，只读）：读请求日志（logs/app-*.log 的 http.request.completed），
// 按主体（登录用户 u:<id>，游客按 IP 段）统计谁拿得多，用来定 ANTI_SCRAPE_LIMITS 的初值、找已经在抓的人。
//
//   npm run scrape:report -- --since 14d [--top 20] [--json]
//   npm run scrape:report -- --since 180d --user-id <UUID>      某个住民按天的用量
//   npm run scrape:report -- --since 30d --subject "ip:1.2.3.0/24"  某个 IP 段按天的用量
//
// 统计：去重详情地点（/places/:id、/places/:id/diaries）、去重分享页（/p/:id）、去重明细瓦片、
// 列表页数、搜索次数、去重住民（/users/:id/places）、旧接口（/places 根路径、/places/markers、/places/nearby）、
// 按 id 递增访问的比例（遍历的特征）、限流日志（anti_scrape.*）和常见 UA。说明见 http/doc/README.md#数据访问限流。
// 住民按日志里的 userId 归类（必须登录、可选登录的接口与带票据的明细瓦片都记，2026-11-18 起）；更早的可选登录请求只有 IP。
// 日志里的坐标、搜索词是打码的，所以 /places/nearby 只统计次数，看不出范围大小。
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ipPrefix } = require('../../http/middleware/rateLimit');

const BACKEND_DIR = path.resolve(__dirname, '../..');

function getArg(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseSince(value) {
    const match = String(value || '14d').trim().match(/^(\d+)(m|h|d)$/i);
    if (match) return Date.now() - Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error(`无法识别 --since ${value}，请使用 30m、2h、14d 或 ISO 时间`);
    return timestamp;
}

function logDirectory() {
    const configured = process.env.LOG_DIR;
    if (!configured) return path.join(BACKEND_DIR, 'logs');
    return path.isAbsolute(configured) ? configured : path.resolve(BACKEND_DIR, configured);
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const beijingDay = (timestamp) => new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

/** 路径（日志里是 originalUrl，经 Caddy 去掉了 /backend 前缀）→ 分类 */
function classify(rawPath) {
    const [pathname] = String(rawPath || '').split('?');
    let m;
    if ((m = pathname.match(/^\/places\/(\d{1,15})(?:\/diaries)?\/?$/))) return { kind: 'detail', member: m[1] };
    if ((m = pathname.match(/^\/p\/(\d{1,15})\/?$/))) return { kind: 'share', member: m[1] };
    if ((m = pathname.match(/^\/places\/tiles\/[^/]+\/12\/(\d+)\/(\d+)$/))) return { kind: 'tiles', member: `${m[1]}/${m[2]}` };
    if (/^\/places\/list\/?$/.test(pathname)) return { kind: 'list' };
    if (/^\/api\/places\/search(?:\/fast)?\/?$/.test(pathname)) return { kind: 'search' };
    if ((m = pathname.match(/^\/users\/([^/]+)\/places\/?$/))) return { kind: 'people', member: m[1] };
    if (/^\/places\/?$/.test(pathname)) return { kind: 'root' };
    if (/^\/places\/markers\/?$/.test(pathname)) return { kind: 'markers' };
    if (/^\/places\/nearby\/?$/.test(pathname)) return { kind: 'nearby' };
    return null;
}

function newSubject(key) {
    return {
        key, requests: 0, ips: new Set(), users: new Set(), userAgents: new Map(), days: new Set(),
        detail: new Set(), detailByDay: new Map(), share: new Set(), tiles: new Set(), people: new Set(),
        list: 0, search: 0, root: 0, markers: 0, nearby: 0, limited: 0, wouldLimit: 0, byDay: new Map(),
        lastDetailId: null, ascending: 0, detailSteps: 0
    };
}

function main() {
    if (process.argv.includes('--help')) {
        console.log('用法：npm run scrape:report -- [--since 14d] [--top 20] [--json] [--user-id UUID | --subject ip:1.2.3.0/24]');
        return;
    }
    const since = parseSince(getArg('--since', '14d'));
    const top = Math.max(1, Math.min(200, Number.parseInt(getArg('--top', '20'), 10) || 20));
    const directory = logDirectory();
    if (!fs.existsSync(directory)) {
        console.log(`日志目录不存在：${directory}`);
        return;
    }
    const oldest = beijingDay(since - 86400000);
    const files = fs.readdirSync(directory)
        .filter((name) => /^app-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name) && name.slice(4, 14) >= oldest)
        .sort();

    const subjects = new Map();
    const rootCallers = new Map();
    const totals = { entries: 0, files: files.length };
    const subjectFor = (entry) => {
        const key = entry.userId ? `u:${entry.userId}` : `ip:${ipPrefix(entry.ip)}`;
        if (!subjects.has(key)) subjects.set(key, newSubject(key));
        return subjects.get(key);
    };

    for (const file of files) {
        const lines = fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/);
        for (const line of lines) {
            if (!line || !line.includes('"event":"')) continue;
            let entry;
            try { entry = JSON.parse(line); } catch (_) { continue; }
            const timestamp = Date.parse(entry.timestamp);
            if (!Number.isFinite(timestamp) || timestamp < since) continue;
            if (entry.event === 'anti_scrape.limited' || entry.event === 'anti_scrape.would_limit') {
                const subject = subjects.get(entry.subject) || newSubject(entry.subject);
                subjects.set(entry.subject, subject);
                if (entry.event === 'anti_scrape.limited') subject.limited += 1; else subject.wouldLimit += 1;
                continue;
            }
            if (entry.event !== 'http.request.completed' || entry.method !== 'GET') continue;
            const kind = classify(entry.path);
            if (!kind) continue;
            totals.entries += 1;
            const subject = subjectFor(entry);
            subject.requests += 1;
            if (entry.ip) subject.ips.add(entry.ip);
            if (entry.userId) subject.users.add(entry.userId);
            const ua = String(entry.userAgent || '-').slice(0, 120);
            subject.userAgents.set(ua, (subject.userAgents.get(ua) || 0) + 1);
            const day = beijingDay(timestamp);
            subject.days.add(day);
            if (!subject.byDay.has(day)) subject.byDay.set(day, { detail: new Set(), share: new Set(), tiles: new Set(), people: new Set(), list: 0, search: 0, nearby: 0, markers: 0, root: 0, requests: 0 });
            const daily = subject.byDay.get(day);
            daily.requests += 1;
            if (kind.member !== undefined && daily[kind.kind] instanceof Set) daily[kind.kind].add(kind.member);
            else if (typeof daily[kind.kind] === 'number') daily[kind.kind] += 1;
            switch (kind.kind) {
                case 'detail': {
                    subject.detail.add(kind.member);
                    if (!subject.detailByDay.has(day)) subject.detailByDay.set(day, new Set());
                    subject.detailByDay.get(day).add(kind.member);
                    const id = Number(kind.member);
                    if (subject.lastDetailId !== null) {
                        subject.detailSteps += 1;
                        const step = id - subject.lastDetailId;
                        if (step >= 1 && step <= 5) subject.ascending += 1;
                    }
                    subject.lastDetailId = id;
                    break;
                }
                case 'share': subject.share.add(kind.member); break;
                case 'tiles': subject.tiles.add(kind.member); break;
                case 'people': subject.people.add(kind.member); break;
                case 'list': subject.list += 1; break;
                case 'search': subject.search += 1; break;
                case 'markers': subject.markers += 1; break;
                case 'nearby': subject.nearby += 1; break;
                case 'root':
                    subject.root += 1;
                    rootCallers.set(ua, (rootCallers.get(ua) || 0) + 1);
                    break;
                default: break;
            }
        }
    }

    const only = getArg('--user-id') ? `u:${getArg('--user-id')}` : getArg('--subject');
    if (only) {
        const subject = subjects.get(only);
        const days = subject ? [...subject.byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, d]) => ({
            day, requests: d.requests, detail: d.detail.size, share: d.share.size, tiles: d.tiles.size, people: d.people.size,
            list: d.list, search: d.search, nearby: d.nearby, markers: d.markers, root: d.root
        })) : [];
        const result = {
            subject: only, since: new Date(since).toISOString(), days,
            ips: subject ? [...subject.ips] : [], wouldLimit: subject?.wouldLimit || 0, limited: subject?.limited || 0,
            userAgents: subject ? [...subject.userAgents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([userAgent, count]) => ({ userAgent, count })) : []
        };
        if (process.argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(`${only} 自 ${result.since}：${days.length} 天有记录，用过 ${result.ips.length} 个 IP，撞线 ${result.wouldLimit + result.limited} 次（would_limit ${result.wouldLimit}，limited ${result.limited}）`);
        if (!days.length) { console.log('  （这段时间没有记录；2026-11-18 之前可选登录接口的请求没记用户，只能按 IP 段查）'); return; }
        console.log('  日期        请求  详情  分享页  明细瓦片  住民  列表  搜索  nearby  旧快照  /places');
        for (const d of days) console.log(`  ${d.day}  ${String(d.requests).padStart(4)}  ${String(d.detail).padStart(4)}  ${String(d.share).padStart(6)}  ${String(d.tiles).padStart(8)}  ${String(d.people).padStart(4)}  ${String(d.list).padStart(4)}  ${String(d.search).padStart(4)}  ${String(d.nearby).padStart(6)}  ${String(d.markers).padStart(6)}  ${String(d.root).padStart(7)}`);
        for (const ua of result.userAgents) console.log(`  UA ${ua.count}  ${ua.userAgent}`);
        return;
    }

    const rows = [...subjects.values()].map((s) => ({
        subject: s.key,
        ips: s.ips.size,
        days: s.days.size,
        requests: s.requests,
        detail: s.detail.size,
        detailMaxDay: Math.max(0, ...[...s.detailByDay.values()].map((set) => set.size)),
        ascendingRatio: s.detailSteps >= 20 ? Math.round((s.ascending / s.detailSteps) * 100) / 100 : null,
        share: s.share.size,
        tiles: s.tiles.size,
        list: s.list,
        search: s.search,
        people: s.people.size,
        root: s.root,
        markers: s.markers,
        nearby: s.nearby,
        wouldLimit: s.wouldLimit,
        limited: s.limited,
        topUserAgent: [...s.userAgents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
    }));
    const by = (field) => [...rows].sort((a, b) => (b[field] || 0) - (a[field] || 0)).filter((row) => row[field] > 0).slice(0, top);
    const report = {
        since: new Date(since).toISOString(),
        files: totals.files,
        requests: totals.entries,
        subjects: rows.length,
        topDetail: by('detailMaxDay'),
        topShare: by('share'),
        topTiles: by('tiles'),
        topList: by('list'),
        topSearch: by('search'),
        topPeople: by('people'),
        topNearby: by('nearby'),
        topLimited: by('wouldLimit').concat(by('limited')).slice(0, top),
        placesRootCallers: [...rootCallers.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([userAgent, count]) => ({ userAgent, count })),
        markersCalls: rows.reduce((sum, row) => sum + row.markers, 0)
    };

    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    console.log(`日志：${directory}，${files.length} 个文件，${report.requests} 条相关 GET 请求，${report.subjects} 个主体（登录用户按账号，游客按 IP 段），自 ${report.since}`);
    const table = (title, list, columns) => {
        console.log(`\n== ${title}`);
        if (!list.length) { console.log('  （无）'); return; }
        for (const row of list) console.log('  ' + columns.map((c) => `${c}=${row[c] ?? '-'}`).join('  ') + `  ua=${row.topUserAgent.slice(0, 60)}`);
    };
    table('单日去重详情地点最多', report.topDetail, ['subject', 'detailMaxDay', 'detail', 'days', 'ascendingRatio', 'ips']);
    table('去重分享页最多', report.topShare, ['subject', 'share', 'days', 'ips']);
    table('去重明细瓦片最多', report.topTiles, ['subject', 'tiles', 'days']);
    table('列表翻页最多', report.topList, ['subject', 'list', 'days']);
    table('搜索最多', report.topSearch, ['subject', 'search', 'days']);
    table('查看住民地点最多', report.topPeople, ['subject', 'people', 'days']);
    table('/places/nearby 最多（旧版 App 或抓取）', report.topNearby, ['subject', 'nearby', 'days']);
    table('撞过限流（anti_scrape.*）', report.topLimited, ['subject', 'wouldLimit', 'limited']);
    console.log(`\n== GET /places 根路径（已停用，回 410）的调用方`);
    if (!report.placesRootCallers.length) console.log('  （无）');
    for (const row of report.placesRootCallers) console.log(`  ${row.count}  ${row.userAgent}`);
    console.log(`\nGET /places/markers（旧快照，只剩旧版 App 在用）共 ${report.markersCalls} 次回源；经 CDN 命中的不在这里，看 ESA 日志。`);
}

main();
