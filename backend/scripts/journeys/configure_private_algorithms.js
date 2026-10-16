const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseEnv } = require('node:util');
const { BACKEND_ROOT } = require('../../infrastructure/paths');

function fail(code, message) { throw Object.assign(new Error(message), {code}); }
const owns = (value, key) => Object.hasOwn(value, key);
const freshToken = () => randomBytes(32).toString('hex');
const validToken = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);

function readEnvironment(filename) {
    let source;
    try { source = fs.readFileSync(filename, 'utf8'); }
    catch (error) {
        if (error.code === 'ENOENT') return {source:'', values:{}};
        fail('JOURNEY_SETUP_CONFIG', 'Cannot read an environment file. Check its permissions.');
    }
    try { return {source, values:parseEnv(source)}; }
    catch { fail('JOURNEY_SETUP_CONFIG', 'Cannot parse an environment file. Check its syntax.'); }
}

function port(value, fallback) {
    if (value === undefined || value === '') return fallback;
    if (!/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) fail('JOURNEY_SETUP_CONFIG', 'A configured port is invalid.');
    return Number(value);
}

function serviceUrl(value) {
    if (typeof value !== 'string' || /[?#\u0000-\u0020\u007f]/.test(value)) fail('JOURNEY_SETUP_CONFIG', 'The algorithm service URL must be an HTTP(S) URL without credentials, query or fragment.');
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
        return parsed.href.replace(/\/+$/, '');
    } catch { fail('JOURNEY_SETUP_CONFIG', 'The algorithm service URL must be an HTTP(S) URL without credentials, query or fragment.'); }
}

function encode(value) {
    // Match the runtime parser, including its literal multiline/quote semantics.
    for (const candidate of [value, `'${value}'`, `\"${value}\"`, `\`${value}\``]) {
        try { if (parseEnv(`VALUE=${candidate}\n`).VALUE === value) return candidate; }
        catch { /* Try the next quoting style without exposing the value. */ }
    }
    fail('JOURNEY_SETUP_CONFIG', 'An environment value cannot be safely serialized.');
}

function updateEnvironment(source, current, updates) {
    const pending = new Map(Object.entries(updates).filter(([key,value]) => current[key] !== value));
    if (!pending.size) return source;
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
    const output = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
        const first = lines[i];
        const firstBody = first.replace(/[\r\n]+$/, '');
        const match = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/.exec(firstBody);
        if (!match) { output.push(first); continue; }
        const key = match[2], value = match[4];
        let block = first;
        let suffix = '';
        const quote = ['\"', "'", '`'].includes(value[0]) ? value[0] : null;
        if (quote) {
            let closing = value.indexOf(quote, 1);
            if (closing >= 0) suffix = value.slice(closing + 1);
            else {
                while (++i < lines.length) {
                    const continuation = lines[i];
                    block += continuation;
                    closing = continuation.indexOf(quote);
                    if (closing >= 0) {
                        suffix = continuation.replace(/[\r\n]+$/, '').slice(closing + 1);
                        break;
                    }
                }
            }
        } else {
            const comment = value.indexOf('#');
            if (comment >= 0) suffix = ' ' + value.slice(comment);
        }
        if (!pending.has(key)) { output.push(block); continue; }
        seen.add(key);
        const ending = /(?:\r\n|\n|\r)$/.exec(block)?.[0] || '';
        output.push(`${match[1]}${key}${match[3]}${encode(pending.get(key))}${suffix}${ending}`);
    }
    let updated = output.join('');
    for (const [key,value] of pending) if (!seen.has(key)) {
        if (updated && !/[\r\n]$/.test(updated)) updated += newline;
        updated += `${key}=${encode(value)}${newline}`;
    }
    const checked = parseEnv(updated);
    if (![...pending].every(([key,value]) => checked[key] === value)) fail('JOURNEY_SETUP_CONFIG', 'An environment file could not be updated safely.');
    return updated;
}

function configure({backendRoot = BACKEND_ROOT, serviceDir, apply = false, url} = {}) {
    backendRoot = path.resolve(backendRoot);
    serviceDir = path.resolve(serviceDir || path.join(backendRoot, '..', '.private', 'journey-algorithm-service'));
    try {
        if (!fs.statSync(backendRoot).isDirectory() || JSON.parse(fs.readFileSync(path.join(serviceDir, 'package.json'), 'utf8')).name !== 'journey-algorithm-service') throw new Error();
    } catch { fail('JOURNEY_SETUP_SERVICE', 'The private algorithm service package is missing or invalid. Provide its directory with --service-dir.'); }
    const backendEnvPath = path.join(backendRoot, '.env');
    const serviceEnvPath = path.join(serviceDir, '.env');
    const backupPath = path.join(serviceDir, '.setup-backups', 'backend-before-algorithm-split.env');
    const result = {applied:!!apply, changed:false, backendEnvPath, serviceEnvPath, backupPath,
        backendEnvExists:fs.existsSync(backendEnvPath), serviceEnvExists:fs.existsSync(serviceEnvPath), backupExists:fs.existsSync(backupPath), backupCreated:false};
    if (!apply) {
        if (url !== undefined) serviceUrl(url);
        return result;
    }
    const backend = readEnvironment(backendEnvPath), service = readEnvironment(serviceEnvPath);
    const b = backend.values, s = service.values;
    const servicePort = port(s.PORT, 7100), backendPort = port(b.PORT, 7000);
    const choose = (key, fallback = '') => owns(s, key) ? s[key] : b[key] || fallback;
    const serviceToken = [s.JOURNEY_ALGORITHM_SERVICE_TOKEN, b.JOURNEY_ALGORITHM_SERVICE_TOKEN].find(validToken) || freshToken();
    const callbackToken = [s.JOURNEY_ALGORITHM_CALLBACK_TOKEN, b.JOURNEY_ALGORITHM_CALLBACK_TOKEN].find(value => validToken(value) && value !== serviceToken) || freshToken();
    const serviceUpdates = {
        HOST:owns(s, 'HOST') ? s.HOST : '127.0.0.1', PORT:owns(s, 'PORT') ? s.PORT : String(servicePort),
        JOURNEY_ALGORITHM_SERVICE_TOKEN:serviceToken, JOURNEY_ALGORITHM_CALLBACK_TOKEN:callbackToken,
        JOURNEY_PLACE_LOOKUP_URL:owns(s, 'JOURNEY_PLACE_LOOKUP_URL') ? s.JOURNEY_PLACE_LOOKUP_URL : `http://127.0.0.1:${backendPort}/internal/journey-algorithms/places`
    };
    for (const [key,value] of Object.entries(b)) if (/^JOURNEY_LLM_[A-Za-z0-9_]+$/.test(key)) serviceUpdates[key] = owns(s,key) ? s[key] : value;
    for (const [suffix,fallback] of Object.entries({API_KEY:'', BASE_URL:'https://api.deepseek.com', MODEL:'deepseek-flash', VISION:'false'})) {
        const key = `JOURNEY_LLM_${suffix}`;
        const privateAlias = suffix === 'VISION' ? '' : s[`DEEPSEEK_${suffix}`];
        serviceUpdates[key] = owns(s,key) ? s[key] : privateAlias || b[key] || b[`DEEPSEEK_${suffix}`] || fallback;
    }
    for (const [key,fallback] of Object.entries({AMAP_WEB_SERVICE_KEY:'', AMAP_JOURNAL_STORAGE_ALLOWED:'false', AMAP_EXPORT_ALLOWED:'false'})) serviceUpdates[key] = choose(key, fallback);
    const backendUpdates = {
        JOURNEY_ALGORITHM_SERVICE_URL:serviceUrl(url === undefined ? b.JOURNEY_ALGORITHM_SERVICE_URL || `http://127.0.0.1:${servicePort}` : url),
        JOURNEY_ALGORITHM_SERVICE_TOKEN:serviceToken, JOURNEY_ALGORITHM_CALLBACK_TOKEN:callbackToken,
        JOURNEY_ALGORITHM_TIMEOUT_MS:b.JOURNEY_ALGORITHM_TIMEOUT_MS || '120000'
    };
    const serviceSource = updateEnvironment(service.source, s, serviceUpdates);
    const backendSource = updateEnvironment(backend.source, b, backendUpdates);
    // Finish validation before making the first filesystem change.
    try {
        fs.mkdirSync(path.dirname(backupPath), {recursive:true, mode:0o700});
        try {
            fs.writeFileSync(backupPath, backend.source, {flag:'wx', mode:0o600});
            result.backupCreated = true;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (serviceSource !== service.source || !result.serviceEnvExists) { fs.writeFileSync(serviceEnvPath, serviceSource, {mode:0o600}); result.changed = true; }
        if (backendSource !== backend.source || !result.backendEnvExists) { fs.writeFileSync(backendEnvPath, backendSource, {mode:0o600}); result.changed = true; }
    } catch { fail('JOURNEY_SETUP_WRITE', 'Cannot write configuration or its backup. Check the directory permissions and retry.'); }
    return {...result, backendEnvExists:true, serviceEnvExists:true, backupExists:true};
}

function main(args = process.argv.slice(2)) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Usage: node scripts/journeys/configure_private_algorithms.js [--apply] [--service-dir PATH] [--url URL]\n\nWithout --apply, report paths and file state without changing configuration.');
        return;
    }
    const options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--apply' && !owns(options,'apply')) options.apply = true;
        else if (['--service-dir','--url'].includes(args[i]) && args[i+1] && !args[i+1].startsWith('--')) {
            const key = args[i] === '--service-dir' ? 'serviceDir' : 'url';
            if (owns(options,key)) fail('JOURNEY_SETUP_ARGUMENT', 'Unknown, duplicate or incomplete argument. Use --help for usage.');
            options[key] = args[++i];
        } else fail('JOURNEY_SETUP_ARGUMENT', 'Unknown, duplicate or incomplete argument. Use --help for usage.');
    }
    const result = configure(options);
    console.log(result.applied ? (result.changed ? 'Configuration applied.' : 'Configuration already current.') : 'Dry run. Configuration was not changed.');
    console.log(`Backend environment: ${result.backendEnvPath} (${result.backendEnvExists ? 'exists' : 'missing'})`);
    console.log(`Service environment: ${result.serviceEnvPath} (${result.serviceEnvExists ? 'exists' : 'missing'})`);
    console.log(`Original backend backup: ${result.backupPath} (${result.backupExists ? 'exists' : 'not created'})`);
    return result;
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        const known = /^JOURNEY_SETUP_(?:SERVICE|CONFIG|WRITE|ARGUMENT)$/.test(error.code || '');
        console.error(known ? `Setup failed [${error.code}]: ${error.message}` : 'Setup failed. Check the configuration and filesystem permissions.');
        process.exitCode = 1;
    }
}

module.exports = {configure, main};
