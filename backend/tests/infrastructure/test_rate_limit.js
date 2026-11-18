// 数据访问限流（http/middleware/rateLimit.js）：IP 段、主体、去重与计次规则、observe / enforce / off 三种模式、
// 429 响应、Redis 与进程内两种计数、计数出错时放行。不打开数据库。npm run test:rate-limit
const assert = require('node:assert/strict');
Object.assign(process.env, { LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false' });

// Redis 替身：只实现限流用到的命令；ready 可切换，用来覆盖“Redis 不可用时退回进程内计数”
const fakeRedis = {
    ready: false,
    sets: new Map(),
    counters: new Map(),
    failing: false,
    isReady() { return this.ready; },
    multi() {
        const ops = [];
        const chain = {
            sismember: (key, member) => { ops.push(() => (fakeRedis.sets.get(key)?.has(member) ? 1 : 0)); return chain; },
            scard: (key) => { ops.push(() => fakeRedis.sets.get(key)?.size || 0); return chain; },
            sadd: (key, member) => { ops.push(() => { if (!fakeRedis.sets.has(key)) fakeRedis.sets.set(key, new Set()); fakeRedis.sets.get(key).add(member); return 1; }); return chain; },
            expire: () => { ops.push(() => 1); return chain; },
            exec: async () => {
                if (fakeRedis.failing) throw new Error('redis down');
                return ops.map((op) => [null, op()]);
            }
        };
        return chain;
    },
    async incr(key) {
        if (fakeRedis.failing) throw new Error('redis down');
        const value = (fakeRedis.counters.get(key) || 0) + 1;
        fakeRedis.counters.set(key, value);
        return value;
    },
    async expire() { return 1; }
};
const express = require('express');
const limiter = require('../../http/middleware/rateLimit');
const { rateLimit, consume, ipPrefix, subjectOf, rulesFor, resetForTesting } = limiter;
limiter.useRedis(fakeRedis);

const guest = (ip = '203.0.113.7') => ({ ip });
const user = (id, admin_level = 0) => ({ ip: '198.51.100.1', viewer: { id, admin_level } });

function setLimits(limits) {
    process.env.ANTI_SCRAPE_LIMITS = JSON.stringify(limits);
    resetForTesting();
}

async function main() {
    // ---- IP 段与主体 ----
    assert.equal(ipPrefix('203.0.113.7'), '203.0.113.0/24');
    assert.equal(ipPrefix('::ffff:203.0.113.7'), '203.0.113.0/24', 'IPv4 映射地址按 IPv4');
    assert.equal(ipPrefix('2408:8459:c40:84f7:4c09:84f:d5eb:e23'), '2408:8459:0c40:84f7::/64');
    assert.equal(ipPrefix('2001:db8::1'), '2001:0db8:0000:0000::/64');
    assert.equal(ipPrefix(''), 'unknown');
    assert.deepEqual(subjectOf(guest()), { key: 'ip:203.0.113.0/24', audience: 'guest' });
    assert.deepEqual(subjectOf(user('a')), { key: 'u:a', audience: 'user' });
    assert.deepEqual(subjectOf(user('admin', 1)), { exempt: true }, '管理员不限');
    assert.deepEqual(subjectOf({ ip: '1.2.3.4', rateSubject: { id: 'ticket' } }).key, 'u:ticket', '瓦片票据认出的账号优先');

    // ---- 覆盖值：不合法时用默认 ----
    setLimits({ detail: { guest: [{ distinct: true, limit: 'x', per: 'day' }] } });
    assert.deepEqual(rulesFor('detail', 'guest'), limiter.DEFAULT_LIMITS.detail.guest);

    // ---- observe（默认）：不拦，计数照记 ----
    delete process.env.ANTI_SCRAPE_MODE;
    setLimits({ detail: { guest: [{ distinct: true, limit: 2, per: 'day' }], user: [{ distinct: true, limit: 3, per: 'day' }] } });
    for (const id of ['1', '2', '3', '4']) assert.equal((await consume('detail', guest(), id)).limited, false, 'observe 只记日志');

    // ---- enforce + 进程内计数：去重、同一地点不重复扣、换主体各算各的 ----
    process.env.ANTI_SCRAPE_MODE = 'enforce';
    resetForTesting();
    assert.equal((await consume('detail', guest(), '1')).limited, false);
    assert.equal((await consume('detail', guest(), '2')).limited, false);
    assert.equal((await consume('detail', guest(), '1')).limited, false, '看过的地点再看不扣额度');
    const blocked = await consume('detail', guest(), '3');
    assert.equal(blocked.limited, true, '第三个不同地点超过游客额度');
    assert.equal(blocked.guest, true);
    assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 86400, '按北京时间次日零点重置');
    assert.equal((await consume('detail', guest(), '3')).limited, true, '被拦的地点没有记进去，再来仍拦');
    assert.equal((await consume('detail', guest(), '2')).limited, false, '额度内看过的照样能看');
    assert.equal((await consume('detail', guest('203.0.113.200'), '9')).limited, true, '同一 /24 段共用额度');
    assert.equal((await consume('detail', guest('198.51.100.9'), '9')).limited, false, '别的网段不受影响');
    for (const id of ['1', '2', '3']) assert.equal((await consume('detail', user('u1'), id)).limited, false, '住民额度更高');
    assert.equal((await consume('detail', user('u1'), '4')).limited, true);
    assert.equal((await consume('detail', user('admin', 2), '99')).limited, false, '管理员不限');
    assert.equal((await consume('detail', guest(), null)).limited, false, '没有计数对象时跳过去重规则');

    // ---- 计次规则 ----
    setLimits({ list: { guest: [{ limit: 2, per: 3600 }], user: [{ limit: 5, per: 3600 }] } });
    assert.equal((await consume('list', guest())).limited, false);
    assert.equal((await consume('list', guest())).limited, false);
    const listBlocked = await consume('list', guest());
    assert.equal(listBlocked.limited, true);
    assert.ok(listBlocked.retryAfter > 0 && listBlocked.retryAfter <= 3600);

    // ---- Redis 计数：同样的语义 ----
    fakeRedis.ready = true;
    setLimits({ detail: { guest: [{ distinct: true, limit: 2, per: 'day' }], user: [{ distinct: true, limit: 2, per: 'day' }] }, search: { guest: [{ limit: 1, per: 600 }], user: [{ limit: 1, per: 600 }] } });
    assert.equal((await consume('detail', guest(), 'a')).limited, false);
    assert.equal((await consume('detail', guest(), 'b')).limited, false);
    assert.equal((await consume('detail', guest(), 'a')).limited, false);
    assert.equal((await consume('detail', guest(), 'c')).limited, true);
    assert.ok([...fakeRedis.sets.keys()].some((key) => key.startsWith('rl:detail:ip:203.0.113.0/24:x:d')), '计数键按策略、主体、北京日期');
    assert.equal((await consume('search', guest())).limited, false);
    assert.equal((await consume('search', guest())).limited, true);
    // Redis 出错：放行（限流不能变成新的故障点）
    fakeRedis.failing = true;
    assert.equal((await consume('detail', guest(), 'zzz')).limited, false);
    assert.equal((await consume('search', guest())).limited, false);
    fakeRedis.failing = false;
    fakeRedis.ready = false;

    // ---- off：不计数 ----
    process.env.ANTI_SCRAPE_MODE = 'off';
    setLimits({ detail: { guest: [{ distinct: true, limit: 0, per: 'day' }] } });
    assert.equal((await consume('detail', guest(), '1')).limited, false);

    // ---- HTTP：429 的格式；observe 时照常返回 ----
    process.env.ANTI_SCRAPE_MODE = 'enforce';
    setLimits({ detail: { guest: [{ distinct: true, limit: 1, per: 'day' }], user: [{ distinct: true, limit: 1, per: 'day' }] } });
    const app = express();
    app.set('trust proxy', 'loopback');
    app.get('/places/:id', rateLimit('detail', { member: (req) => req.params.id }), (req, res) => res.json({ id: req.params.id }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const headers = { 'X-Forwarded-For': '192.0.2.10' };
        assert.equal((await fetch(`${base}/places/1`, { headers })).status, 200);
        const limited = await fetch(`${base}/places/2`, { headers });
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get('cache-control'), 'no-store');
        assert.ok(Number(limited.headers.get('retry-after')) > 0);
        const body = await limited.json();
        assert.equal(body.code, 'rate_limited');
        assert.equal(body.guest, true);
        assert.ok(body.retry_after > 0 && typeof body.error === 'string');
        // loopback 信任：来自本机代理的 X-Forwarded-For 被采纳，换一个客户端地址就是另一个主体
        assert.equal((await fetch(`${base}/places/2`, { headers: { 'X-Forwarded-For': '192.0.3.10' } })).status, 200);
        process.env.ANTI_SCRAPE_MODE = 'observe';
        assert.equal((await fetch(`${base}/places/3`, { headers })).status, 200, 'observe 不拦');
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }

    console.log('Rate limit passed: IP prefixes, subjects and admin exemption, overrides, observe/enforce/off, distinct and count rules, memory and Redis counters, fail open, 429 response.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
