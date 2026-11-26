const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '../../../../.private/resource-packs');
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
const FILE = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:json|moc3|png|jpe?g|webp|gif|mp3|wav|ogg)$/i;
const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;
const AVATAR = /\.(?:png|webp)$/i;
const EXPIRES_SECONDS = 300;
const AVATAR_SECONDS = 24 * 60 * 60;
const signingKey = process.env.JWT_SECRET
    ? crypto.createHmac('sha256', process.env.JWT_SECRET).update('resource-pack-download').digest()
    : crypto.randomBytes(32);
const audience = 'resource-pack-download';
const avatarAudience = 'resource-pack-avatar';

function rootPath() {
    return path.resolve(process.env.RESOURCE_PACK_DIR || ROOT);
}

function listPacks(type) {
    if (type !== 'companion' && type !== 'skin') return [];
    let data;
    try {
        data = JSON.parse(fs.readFileSync(path.join(rootPath(), 'catalog.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const rows = data[type === 'companion' ? 'companions' : 'skins'];
    const defaultId = type === 'companion' ? 'stick-figure' : 'default';
    return (Array.isArray(rows) ? rows : []).filter((pack) => pack && typeof pack.id === 'string' && ID.test(pack.id) && pack.id !== defaultId
        && typeof pack.name === 'string' && pack.name.trim() && typeof pack.version === 'string' && VERSION.test(pack.version)
        && typeof pack.entry === 'string' && FILE.test(pack.entry)
        && (type === 'skin' ? pack.entry.endsWith('.json') : pack.entry.endsWith('.model3.json')))
        .map(({ id, name, version, entry, avatar }) => ({
            id, name, version: String(version), entry, type,
            ...(type === 'companion' && typeof avatar === 'string' && FILE.test(avatar) && AVATAR.test(avatar) ? { avatar } : {})
        }));
}

function findPack(type, id) {
    return listPacks(type).find((pack) => pack.id === id) || null;
}

function packPath(pack) {
    return path.join(rootPath(), pack.type, pack.id, pack.version);
}

function packFile(pack, relative) {
    if (typeof relative !== 'string' || !FILE.test(relative)) return null;
    try {
        const root = fs.realpathSync(rootPath());
        const folder = fs.realpathSync(packPath(pack));
        const file = fs.realpathSync(path.join(folder, relative));
        if (!folder.startsWith(root + path.sep) || !file.startsWith(folder + path.sep)) return null;
        return fs.statSync(file).isFile() ? file : null;
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
    }
}

function grantPack(pack, userId) {
    const grant = jwt.sign({ type: pack.type, id: pack.id, version: pack.version }, signingKey, {
        algorithm: 'HS256', audience, subject: userId, expiresIn: EXPIRES_SECONDS
    });
    const images = pack.type === 'skin' ? fs.readdirSync(packPath(pack), { recursive: true })
        .map((file) => file.replace(/\\/g, '/')).filter((file) => IMAGE.test(file) && packFile(pack, file)) : [];
    return { base: `/api/skins/packs/access/${grant}/`, entry: pack.entry, version: pack.version, images };
}

function readGrant(grant) {
    try {
        return jwt.verify(grant, signingKey, { algorithms: ['HS256'], audience });
    } catch {
        return null;
    }
}

function avatarFile(pack) {
    const file = pack?.type === 'companion' && pack.avatar && AVATAR.test(pack.avatar) ? packFile(pack, pack.avatar) : null;
    return file && AVATAR.test(file) ? file : null;
}

function avatarUrl(pack) {
    if (!avatarFile(pack)) return null;
    const grant = jwt.sign({ id: pack.id, version: pack.version, file: pack.avatar }, signingKey, {
        algorithm: 'HS256', audience: avatarAudience, expiresIn: AVATAR_SECONDS
    });
    return `/api/skins/packs/avatar/${grant}`;
}

function readAvatarGrant(token) {
    try {
        const grant = jwt.verify(token, signingKey, { algorithms: ['HS256'], audience: avatarAudience });
        const pack = findPack('companion', grant.id);
        const file = pack?.version === grant.version && pack.avatar === grant.file ? avatarFile(pack) : null;
        return file ? { file, exp: grant.exp } : null;
    } catch (error) {
        if (error instanceof jwt.JsonWebTokenError) return null;
        throw error;
    }
}

module.exports = { listPacks, findPack, packFile, grantPack, readGrant, avatarUrl, readAvatarGrant };
