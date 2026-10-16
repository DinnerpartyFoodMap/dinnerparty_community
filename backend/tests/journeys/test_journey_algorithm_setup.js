const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-algorithm-setup-'));
const helperPath = path.resolve(__dirname, '../../scripts/journeys/configure_private_algorithms.js');
let count = 0;
function fixture({backend='', service, packageName='journey-algorithm-service'} = {}) {
    const root = path.join(temporary, String(++count));
    const backendRoot = path.join(root, 'backend');
    const serviceDir = path.join(root, '.private', 'journey-algorithm-service');
    fs.mkdirSync(backendRoot, {recursive:true});
    fs.mkdirSync(serviceDir, {recursive:true});
    fs.writeFileSync(path.join(serviceDir, 'package.json'), JSON.stringify({name:packageName}));
    if (backend !== null) fs.writeFileSync(path.join(backendRoot, '.env'), backend);
    if (service !== undefined) fs.writeFileSync(path.join(serviceDir, '.env'), service);
    return {root,backendRoot,serviceDir};
}
const read = filename => parseEnv(fs.readFileSync(filename, 'utf8'));
const snapshot = directory => fs.readdirSync(directory,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())
    .map(entry=>{const filename=path.join(entry.parentPath,entry.name);return [path.relative(directory,filename),fs.readFileSync(filename).toString('base64')];}).sort();

function main() {
    let configure;
    assert.doesNotThrow(()=>{({configure}=require(helperPath));},'the public local setup helper must be available');
    const original = '# Existing backend comments stay here\r\nPORT=7456\r\nUNRELATED="private-original" # preserve this comment\r\n'+
        'JOURNEY_LLM_API_KEY=journey-private-key\r\nJOURNEY_LLM_BASE_URL=https://model.example/v1\r\nJOURNEY_LLM_MODEL=custom-model\r\n'+
        'JOURNEY_LLM_VISION=true\r\nJOURNEY_LLM_TIMEOUT_MS=45000\r\nAMAP_WEB_SERVICE_KEY=map-private-key\r\n'+
        'AMAP_JOURNAL_STORAGE_ALLOWED=true\r\nAMAP_EXPORT_ALLOWED=false\r\nMULTILINE="keep\r\nthis line"\r\n';
    const env = fixture({backend:original});
    const before = snapshot(env.root);
    const processBefore = {...process.env};
    const preview = configure(env);
    assert.equal(preview.applied,false);
    assert.equal(preview.changed,false);
    assert.equal(preview.backendEnvExists,true);
    assert.equal(preview.serviceEnvExists,false);
    assert.equal(preview.backupExists,false);
    assert.deepEqual(snapshot(env.root),before,'dry-run must not create config, backup or directories');
    assert.ok(!JSON.stringify(preview).includes('private-original'));
    assert.ok(!JSON.stringify(preview).includes('private-key'));
    assert.ok(Object.values(preview).every(value=>typeof value==='string'||typeof value==='boolean'));

    const applied = configure({...env,apply:true});
    assert.equal(applied.applied,true);
    assert.equal(applied.changed,true);
    assert.equal(applied.backupCreated,true);
    assert.equal(applied.backupExists,true);
    assert.equal(fs.readFileSync(applied.backupPath,'utf8'),original,'backup must preserve the exact original backend env');
    const backend = read(applied.backendEnvPath),service = read(applied.serviceEnvPath);
    assert.match(service.JOURNEY_ALGORITHM_SERVICE_TOKEN,/^[a-f0-9]{64}$/);
    assert.match(service.JOURNEY_ALGORITHM_CALLBACK_TOKEN,/^[a-f0-9]{64}$/);
    assert.notEqual(service.JOURNEY_ALGORITHM_SERVICE_TOKEN,service.JOURNEY_ALGORITHM_CALLBACK_TOKEN);
    assert.equal(backend.JOURNEY_ALGORITHM_SERVICE_TOKEN,service.JOURNEY_ALGORITHM_SERVICE_TOKEN);
    assert.equal(backend.JOURNEY_ALGORITHM_CALLBACK_TOKEN,service.JOURNEY_ALGORITHM_CALLBACK_TOKEN);
    assert.equal(backend.JOURNEY_ALGORITHM_SERVICE_URL,'http://127.0.0.1:7100');
    assert.equal(backend.JOURNEY_ALGORITHM_TIMEOUT_MS,'120000');
    assert.equal(service.HOST,'127.0.0.1');assert.equal(service.PORT,'7100');
    assert.equal(service.JOURNEY_PLACE_LOOKUP_URL,'http://127.0.0.1:7456/internal/journey-algorithms/places');
    assert.equal(service.JOURNEY_LLM_API_KEY,'journey-private-key');assert.equal(service.JOURNEY_LLM_BASE_URL,'https://model.example/v1');
    assert.equal(service.JOURNEY_LLM_MODEL,'custom-model');assert.equal(service.JOURNEY_LLM_VISION,'true');assert.equal(service.JOURNEY_LLM_TIMEOUT_MS,'45000');
    assert.equal(service.AMAP_WEB_SERVICE_KEY,'map-private-key');assert.equal(service.AMAP_JOURNAL_STORAGE_ALLOWED,'true');assert.equal(service.AMAP_EXPORT_ALLOWED,'false');
    assert.ok(fs.readFileSync(applied.backendEnvPath,'utf8').startsWith(original));
    assert.equal(backend.MULTILINE,'keep\nthis line');
    for(const value of ['private-original','private-key',service.JOURNEY_ALGORITHM_SERVICE_TOKEN,service.JOURNEY_ALGORITHM_CALLBACK_TOKEN])assert.ok(!JSON.stringify(applied).includes(value));
    assert.deepEqual({...process.env},processBefore,'configuration must not load either env into the running process');
    const after = snapshot(env.root);
    const repeated = configure({...env,apply:true});
    assert.equal(repeated.changed,false);assert.equal(repeated.backupCreated,false);
    assert.deepEqual(snapshot(env.root),after,'re-running setup must not change tokens, config bytes, or backup');
    fs.appendFileSync(applied.backendEnvPath,'\r\nNEW_UNRELATED=changed\r\n');
    configure({...env,apply:true});
    assert.equal(fs.readFileSync(applied.backupPath,'utf8'),original,'the first backup must never be overwritten');

    const fallback=fixture({backend:'DEEPSEEK_API_KEY=fallback-private-key\nDEEPSEEK_BASE_URL=https://fallback.example/v1\nDEEPSEEK_MODEL=fallback-model\nJOURNEY_LLM_API_KEY=\n'});
    const migrated=configure({...fallback,apply:true});
    assert.equal(read(migrated.serviceEnvPath).JOURNEY_LLM_API_KEY,'fallback-private-key');
    assert.equal(read(migrated.serviceEnvPath).JOURNEY_LLM_BASE_URL,'https://fallback.example/v1');
    assert.equal(read(migrated.serviceEnvPath).JOURNEY_LLM_MODEL,'fallback-model');
    assert.equal(read(migrated.serviceEnvPath).JOURNEY_LLM_VISION,'false');
    const privateAliases=fixture({
        backend:'JOURNEY_LLM_API_KEY=backend-key\nJOURNEY_LLM_BASE_URL=https://backend.example/v1\nJOURNEY_LLM_MODEL=backend-model\nJOURNEY_LLM_VISION=false\n',
        service:'DEEPSEEK_API_KEY=private-alias-key\nDEEPSEEK_BASE_URL=https://private.example/v1\nDEEPSEEK_MODEL=private-alias-model\nDEEPSEEK_VISION=true\n'
    });
    const preservedAliases=configure({...privateAliases,apply:true});
    const aliasService=read(preservedAliases.serviceEnvPath);
    assert.equal(aliasService.JOURNEY_LLM_API_KEY,'private-alias-key','existing private API aliases must outrank backend model config');
    assert.equal(aliasService.JOURNEY_LLM_BASE_URL,'https://private.example/v1');
    assert.equal(aliasService.JOURNEY_LLM_MODEL,'private-alias-model');
    assert.equal(aliasService.JOURNEY_LLM_VISION,'false','DEEPSEEK_VISION is not a supported service runtime alias');
    assert.equal(aliasService.DEEPSEEK_API_KEY,'private-alias-key');
    const aliasFiles=snapshot(privateAliases.root);
    assert.equal(configure({...privateAliases,apply:true}).changed,false);
    assert.deepEqual(snapshot(privateAliases.root),aliasFiles);
    const explicitEmpty=configure({...fixture({
        backend:'JOURNEY_LLM_API_KEY=backend-key\nJOURNEY_LLM_BASE_URL=https://backend.example\nJOURNEY_LLM_MODEL=backend-model\n',
        service:'JOURNEY_LLM_API_KEY=\nJOURNEY_LLM_BASE_URL=\nJOURNEY_LLM_MODEL=\nDEEPSEEK_API_KEY=private-alias-key\nDEEPSEEK_BASE_URL=https://private.example\nDEEPSEEK_MODEL=private-alias-model\n'
    }),apply:true});
    assert.equal(read(explicitEmpty.serviceEnvPath).JOURNEY_LLM_API_KEY,'','explicit private JOURNEY_LLM values, including empty ones, remain authoritative');
    assert.equal(read(explicitEmpty.serviceEnvPath).JOURNEY_LLM_BASE_URL,'');
    assert.equal(read(explicitEmpty.serviceEnvPath).JOURNEY_LLM_MODEL,'');
    const empty=configure({...fixture({backend:null}),apply:true});
    assert.equal(read(empty.serviceEnvPath).JOURNEY_LLM_BASE_URL,'https://api.deepseek.com');
    assert.equal(read(empty.serviceEnvPath).JOURNEY_LLM_MODEL,'deepseek-flash');
    assert.equal(read(empty.serviceEnvPath).JOURNEY_PLACE_LOOKUP_URL,'http://127.0.0.1:7000/internal/journey-algorithms/places');

    const existing=fixture({backend:'JOURNEY_ALGORITHM_SERVICE_TOKEN=backend-token\nJOURNEY_ALGORITHM_CALLBACK_TOKEN=backend-callback\n'+
        'JOURNEY_ALGORITHM_SERVICE_URL=https://algorithms.example/prefix\nJOURNEY_ALGORITHM_TIMEOUT_MS=45000\nJOURNEY_LLM_API_KEY=backend-private-key\n',
        service:'# Keep service comment\nHOST=0.0.0.0\nPORT=7210\nJOURNEY_LLM_API_KEY=service-private-key\nJOURNEY_LLM_MODEL=service-model\n'+
        'JOURNEY_LLM_VISION=false\nAMAP_EXPORT_ALLOWED=true\nJOURNEY_PLACE_LOOKUP_URL=https://map.example/internal/journey-algorithms/places\n'+
        'JOURNEY_ALGORITHM_SERVICE_TOKEN=service-token # keep token comment\nJOURNEY_ALGORITHM_CALLBACK_TOKEN=service-callback\nUNRELATED="stay"\n'});
    const existingResult=configure({...existing,apply:true});
    const existingBackend=read(existingResult.backendEnvPath),existingService=read(existingResult.serviceEnvPath);
    assert.equal(existingBackend.JOURNEY_ALGORITHM_SERVICE_TOKEN,'service-token');assert.equal(existingBackend.JOURNEY_ALGORITHM_CALLBACK_TOKEN,'service-callback');
    assert.equal(existingBackend.JOURNEY_ALGORITHM_SERVICE_URL,'https://algorithms.example/prefix');assert.equal(existingBackend.JOURNEY_ALGORITHM_TIMEOUT_MS,'45000');
    assert.equal(existingService.JOURNEY_LLM_API_KEY,'service-private-key');assert.equal(existingService.JOURNEY_LLM_MODEL,'service-model');
    assert.equal(existingService.HOST,'0.0.0.0');assert.equal(existingService.PORT,'7210');assert.equal(existingService.AMAP_EXPORT_ALLOWED,'true');
    assert.equal(existingService.JOURNEY_PLACE_LOOKUP_URL,'https://map.example/internal/journey-algorithms/places','existing remote callback settings must be preserved');
    assert.equal(existingService.UNRELATED,'stay');assert.ok(fs.readFileSync(existingResult.serviceEnvPath,'utf8').includes('# Keep service comment'));
    configure({...existing,apply:true,url:'https://new.example/private/'});
    assert.equal(read(existingResult.backendEnvPath).JOURNEY_ALGORITHM_SERVICE_URL,'https://new.example/private');
    const backendTokens=configure({...fixture({backend:'JOURNEY_ALGORITHM_SERVICE_TOKEN=existing-token\nJOURNEY_ALGORITHM_CALLBACK_TOKEN=existing-callback\n'}),apply:true});
    assert.equal(read(backendTokens.serviceEnvPath).JOURNEY_ALGORITHM_SERVICE_TOKEN,'existing-token');
    assert.equal(read(backendTokens.serviceEnvPath).JOURNEY_ALGORITHM_CALLBACK_TOKEN,'existing-callback');
    const collision=configure({...fixture({service:'JOURNEY_ALGORITHM_SERVICE_TOKEN=shared-token\nJOURNEY_ALGORITHM_CALLBACK_TOKEN=shared-token\n'}),apply:true});
    assert.equal(read(collision.serviceEnvPath).JOURNEY_ALGORITHM_SERVICE_TOKEN,'shared-token');
    assert.notEqual(read(collision.serviceEnvPath).JOURNEY_ALGORITHM_CALLBACK_TOKEN,'shared-token');

    const multiline = fixture({backend:'JOURNEY_LLM_API_KEY="first\nsecond" # preserve key comment\nDEEPSEEK_API_KEY=unused\n',
        service:'JOURNEY_ALGORITHM_SERVICE_TOKEN="old\ntoken" # preserve token comment\nUNRELATED=keep\n'});
    const multilineResult=configure({...multiline,apply:true});
    assert.equal(read(multilineResult.serviceEnvPath).JOURNEY_LLM_API_KEY,'first\nsecond');
    assert.match(read(multilineResult.serviceEnvPath).JOURNEY_ALGORITHM_SERVICE_TOKEN,/^[a-f0-9]{64}$/);
    assert.ok(fs.readFileSync(multilineResult.serviceEnvPath,'utf8').includes('# preserve token comment'));
    assert.equal(read(multilineResult.serviceEnvPath).UNRELATED,'keep');

    for(const url of ['file:///private','https://user:password@example.com','https://example.com?key=private','https://example.com/#private']) {
        const invalid=fixture();const originalFiles=snapshot(invalid.root);
        assert.throws(()=>configure({...invalid,apply:true,url}),error=>error.code==='JOURNEY_SETUP_CONFIG'&&!error.message.includes(url));
        assert.deepEqual(snapshot(invalid.root),originalFiles,'invalid config must not partially write secrets');
    }
    const wrongPackage=fixture({packageName:'unrelated-service'});
    assert.throws(()=>configure(wrongPackage),error=>error.code==='JOURNEY_SETUP_SERVICE');
    fs.writeFileSync(path.join(wrongPackage.serviceDir,'package.json'),'invalid PRIVATE_SENTINEL');
    assert.throws(()=>configure(wrongPackage),error=>error.code==='JOURNEY_SETUP_SERVICE'&&!error.message.includes('PRIVATE_SENTINEL'));

    const cli=spawnSync(process.execPath,[helperPath,'--service-dir',env.serviceDir],{encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);
    assert.ok(cli.stdout.includes('Dry run'));assert.ok(cli.stdout.includes(env.serviceDir));
    assert.ok(!cli.stdout.includes(service.JOURNEY_ALGORITHM_SERVICE_TOKEN));
    assert.ok(!cli.stdout.includes('private-key'));
    const cliFixture=fixture({backend:'JOURNEY_LLM_API_KEY=cli-private-key\n'});
    const installedHelper=path.join(cliFixture.backendRoot,'scripts','journeys','configure_private_algorithms.js');
    fs.mkdirSync(path.dirname(installedHelper),{recursive:true});
    fs.mkdirSync(path.join(cliFixture.backendRoot,'infrastructure'),{recursive:true});
    fs.copyFileSync(helperPath,installedHelper);
    fs.copyFileSync(path.resolve(__dirname,'../../infrastructure/paths.js'),path.join(cliFixture.backendRoot,'infrastructure','paths.js'));
    const cliApply=spawnSync(process.execPath,[installedHelper,'--apply','--service-dir',cliFixture.serviceDir,'--url','http://127.0.0.1:7300'],{encoding:'utf8'});
    assert.equal(cliApply.status,0,cliApply.stderr);
    assert.ok(cliApply.stdout.includes('Configuration applied'));
    const cliBackend=read(path.join(cliFixture.backendRoot,'.env'));
    assert.equal(cliBackend.JOURNEY_ALGORITHM_SERVICE_URL,'http://127.0.0.1:7300');
    assert.ok(!cliApply.stdout.includes(cliBackend.JOURNEY_ALGORITHM_SERVICE_TOKEN));
    assert.ok(!cliApply.stdout.includes(cliBackend.JOURNEY_ALGORITHM_CALLBACK_TOKEN));
    assert.ok(!cliApply.stdout.includes('cli-private-key'));
    const cliFailure=spawnSync(process.execPath,[helperPath,'--unknown=PRIVATE_SENTINEL'],{encoding:'utf8'});
    assert.notEqual(cliFailure.status,0);assert.ok(!cliFailure.stderr.includes('PRIVATE_SENTINEL'));
    console.log('Journey algorithm setup tests passed: dry-run isolation, repeatable migration, separate tokens, immutable backup, preserved config and safe reporting.');
}

try { main(); } catch(error) {console.error(error);process.exitCode=1;} finally {
    const absolute=path.resolve(temporary),root=path.resolve(os.tmpdir())+path.sep;
    if(absolute.startsWith(root)&&path.basename(absolute).startsWith('yuyuko-algorithm-setup-'))fs.rmSync(absolute,{recursive:true,force:true});
}
