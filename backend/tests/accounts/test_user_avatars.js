const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');

const userId = 'test-avatar-user';
const publicBaseUrl = 'https://images.example.test';
const avatarRoute = `/users/${userId}/avatar`;

async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

async function startFakeOss() {
    const objects = new Map();
    let rejectPut = false;
    let heldDelete;
    const server = http.createServer(async (req, res) => {
        const key = req.url.slice(1).split('?')[0];
        if (req.method === 'DELETE') {
            if (heldDelete?.key === key) {
                const hold = heldDelete;
                heldDelete = undefined;
                hold.notify();
                await hold.release;
            }
            objects.delete(key);
            return res.writeHead(204).end();
        }
        if (req.method !== 'PUT') return res.writeHead(404).end();
        if (rejectPut) return res.writeHead(403, { 'Content-Type': 'application/xml' }).end('<Error><Code>AccessDenied</Code></Error>');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        objects.set(key, {
            body: Buffer.concat(chunks),
            type: req.headers['content-type'],
            cacheControl: req.headers['cache-control']
        });
        return res.writeHead(200, { ETag: '"test-object"' }).end();
    });
    const endpoint = await listen(server);
    return {
        server, endpoint, objects,
        rejectUploads: () => { rejectPut = true; },
        holdDelete(key) {
            let notify;
            let resume;
            const started = new Promise((resolve) => { notify = resolve; });
            const release = new Promise((resolve) => { resume = resolve; });
            heldDelete = { key, notify, release };
            return { started, resume };
        }
    };
}

async function exerciseAvatars(ossMode) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-user-avatars-'));
    const uploadsDir = path.join(temp, 'uploads');
    const oss = ossMode ? await startFakeOss() : null;
    Object.assign(process.env, {
        DB_FILE: path.join(temp, 'test.sqlite'), UPLOADS_DIR: uploadsDir,
        LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', IMAGE_STORAGE: oss ? 'oss' : 'local',
        SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
        ...(oss && {
            OSS_REGION: 'oss-cn-hangzhou', OSS_BUCKET: 'avatars-test', OSS_ENDPOINT: oss.endpoint,
            OSS_ACCESS_KEY_ID: 'test-id', OSS_ACCESS_KEY_SECRET: 'test-secret',
            OSS_PREFIX: 'food', OSS_PUBLIC_BASE_URL: publicBaseUrl
        })
    });
    const { db, init } = require('../../infrastructure/database');
    const { requireAuth, setSessionStoreForTesting } = require('../../modules/accounts/middleware/auth');
    const { createSessionStore } = require('../../modules/accounts/services/sessions');
    const { FakeRedis } = require('../helpers/fakeRedis');
    const users = require('../../modules/accounts/routes/users');
    init();
    setSessionStoreForTesting(createSessionStore(new FakeRedis()));
    const app = express();
    app.use(express.json());
    app.use('/users', users);
    app.use('/admin/users', requireAuth, require('../../modules/admin/routes/adminUsers'));
    app.use('/admin/general-users', requireAuth, require('../../modules/admin/routes/adminGeneralUsers'));
    const server = http.createServer(app);
    const base = await listen(server);
    const storedAvatar = (url) => oss.objects.get(url.slice(publicBaseUrl.length + 1));

    try {
        const password = 'avatar-password';
        const passwordHash = createHash('sha256').update(password).digest('hex');
        const insertUser = db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)');
        insertUser.run(userId, 'avatar-user', passwordHash, null);
        const login = async (username = 'avatar-user') => (await fetch(`${base}/users/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        })).json();
        const { token, user } = await login();
        const auth = { Authorization: `Bearer ${token}` };
        const currentUser = async () => {
            const response = await fetch(`${base}/users/me`, { headers: auth });
            assert.equal(response.headers.get('cache-control'), 'no-store');
            return (await response.json()).user;
        };
        const profileUser = async () => {
            const res = await fetch(`${base}/users/${userId}/profile`);
            const body = await res.json();
            assert.equal(res.status, 200, JSON.stringify(body));
            return body.user;
        };
        const legacyAvatar = (query = '') => fetch(`${base}${avatarRoute}${query}`, { redirect: 'manual' });

        assert.equal(user.has_avatar, false);
        assert.equal(user.avatar_url, null, 'login explicitly returns null when there is no avatar');
        assert.equal((await legacyAvatar()).status, 404);
        const defaults = await legacyAvatar('?fallback=default');
        assert.equal(defaults.status, 200);
        assert.equal(defaults.headers.get('content-type'), 'image/png');
        assert.equal(defaults.headers.get('cache-control'), 'no-store');

        const first = await sharp({ create: { width: 25, height: 32, channels: 3, background: '#7d462e' } }).png().toBuffer();
        const second = await sharp({ create: { width: 32, height: 25, channels: 3, background: '#4d518c' } }).png().toBuffer();
        const blob = await sharp(first).webp().toBuffer();
        db._raw.prepare('UPDATE User SET avatar_blob = ? WHERE id = ?').run(blob, userId);
        const existing = (await currentUser()).avatar_url;
        assert.equal(existing, `${avatarRoute}/legacy`);
        assert.equal((await login()).user.avatar_url, existing);
        assert.equal((await profileUser()).avatar_url, existing);
        const oldImage = await fetch(`${base}${existing}`);
        assert.equal(oldImage.headers.get('content-type'), 'image/webp');
        assert.equal(oldImage.headers.get('cache-control'), 'no-store');
        assert.deepEqual(Buffer.from(await oldImage.arrayBuffer()), blob);
        const upload = async (bytes, headers = auth) => {
            const form = new FormData();
            form.append('avatar', new Blob([bytes], { type: 'image/png' }), 'avatar.png');
            return fetch(`${base}/users/me/avatar`, { method: 'PUT', headers, body: form });
        };
        if (!oss) {
            const uploadResponse = await upload(first);
            assert.equal(uploadResponse.status, 503);
            assert.match((await uploadResponse.json()).error, /OSS/);
            assert.equal((await currentUser()).avatar_url, existing);
            assert.equal(fs.existsSync(uploadsDir), false);
            console.log('Avatar uploads require OSS');
            return;
        }
        const uploadUrl = async (bytes, headers) => {
            const response = await upload(bytes, headers);
            const payload = await response.json();
            assert.equal(response.status, 200, JSON.stringify(payload));
            assert.equal(payload.user.has_avatar, true);
            const { avatar_url: url } = payload.user;
            assert.ok(url.startsWith(`${publicBaseUrl}/food/avatars/`));
            return url;
        };
        const firstUrl = await uploadUrl(first);
        const { format, width, height } = await sharp(storedAvatar(firstUrl).body).metadata();
        assert.deepEqual([format, width, height], ['webp', 200, 200]);
        assert.equal(db._raw.prepare('SELECT avatar_blob FROM User WHERE id = ?').get(userId).avatar_blob, null);
        const legacyRedirect = await fetch(`${base}${existing}`, { redirect: 'manual' });
        assert.equal(legacyRedirect.status, 302);
        assert.equal(legacyRedirect.headers.get('location'), firstUrl);
        assert.equal(legacyRedirect.headers.get('cache-control'), 'no-store');
        const secondUrl = await uploadUrl(second);
        assert.notEqual(firstUrl, secondUrl);
        assert.equal(storedAvatar(firstUrl), undefined);
        assert.equal((await currentUser()).avatar_url, secondUrl);
        assert.equal((await login()).user.avatar_url, secondUrl);
        assert.equal((await profileUser()).avatar_url, secondUrl);
        const redirect = await legacyAvatar();
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get('location'), secondUrl);
        assert.equal(redirect.headers.get('cache-control'), 'no-store');

        const cleanup = oss.holdDelete(new URL(secondUrl).pathname.slice(1));
        const slowResponse = uploadUrl(first);
        await cleanup.started;
        const supersededUrl = (await currentUser()).avatar_url;
        const latestUrl = await uploadUrl(second).finally(cleanup.resume);
        assert.equal(new Set([firstUrl, secondUrl, supersededUrl, latestUrl]).size, 4);
        assert.equal(await slowResponse, latestUrl, 'a delayed response must not return the superseded, deleted object');
        assert.equal((await currentUser()).avatar_url, latestUrl);
        assert.equal(oss.objects.size, 1);
        assert.ok(storedAvatar(latestUrl));

        db._raw.exec(`CREATE TEMP TRIGGER reject_avatar_change BEFORE UPDATE OF avatar_url ON User
            BEGIN SELECT RAISE(ABORT, 'test database write failure'); END;`);
        assert.equal((await upload(first)).status, 500);
        assert.equal((await currentUser()).avatar_url, latestUrl);
        assert.equal(oss.objects.size, 1);
        db._raw.exec('DROP TRIGGER reject_avatar_change');

        const object = storedAvatar(latestUrl);
        assert.equal(object.type, 'image/webp');
        assert.match(object.cacheControl, /immutable/);

        for (const [route, level] of [['users', 'YUYUKO'], ['general-users', 'YOUMU']]) {
            const adminName = `avatar-admin-${route}`;
            insertUser.run(randomUUID(), adminName, passwordHash, level);
            const adminAuth = { Authorization: `Bearer ${(await login(adminName)).token}` };
            const subjectId = randomUUID();
            const subjectName = `avatar-subject-${route}`;
            insertUser.run(subjectId, subjectName, passwordHash, null);
            const subjectAuth = { Authorization: `Bearer ${(await login(subjectName)).token}` };
            const subjectUrl = await uploadUrl(first, subjectAuth);
            const listing = await fetch(`${base}/admin/${route}`, { headers: adminAuth });
            assert.equal(listing.status, 200);
            const subject = (await listing.json()).find((row) => row.id === subjectId);
            assert.equal(subject.has_avatar, true);
            assert.equal(subject.avatar_url, subjectUrl);
            const deletion = await fetch(`${base}/admin/${route}/${subjectId}`, { method: 'DELETE', headers: adminAuth });
            assert.equal(deletion.status, 200);
            assert.equal(storedAvatar(subjectUrl), undefined);
            assert.ok(storedAvatar(latestUrl));
        }

        oss.rejectUploads();
        assert.equal((await upload(first)).status, 500);
        assert.equal((await currentUser()).avatar_url, latestUrl);
        assert.equal(oss.objects.size, 1);
        assert.equal(fs.existsSync(uploadsDir), false);
        assert.equal((await fetch(`${base}/users/me`, { method: 'DELETE', headers: auth })).status, 200);
        assert.equal(storedAvatar(latestUrl), undefined);
        assert.equal((await legacyAvatar()).status, 404);
        console.log('OSS avatar lifecycle tests passed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        if (oss) await new Promise((resolve) => oss.server.close(resolve));
        db.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

async function main() {
    const ossMode = process.argv.includes('--oss');
    await exerciseAvatars(ossMode);
    if (!ossMode) {
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [__filename, '--oss'], { stdio: 'inherit' });
            child.on('error', reject);
            child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`OSS avatar tests exited ${status}`)));
        });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
