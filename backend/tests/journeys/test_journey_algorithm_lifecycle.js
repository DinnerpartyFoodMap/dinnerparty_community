const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-algorithm-lifecycle-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
const { db, init } = require('../../infrastructure/database');
const store = require('../../modules/journeys/services/journeyStore');
const merge = require('../../modules/journeys/services/journeyMerge');
const resolution = require('../../modules/journeys/services/journeyResolution');
const drafts = require('../../modules/journeys/services/journeyDrafts');
const ai = require('../../modules/journeys/services/journeyAI');
const { createJourneyAlgorithmFixture } = require('../helpers/journeyAlgorithmFixture');
const sql = db._raw;
let fixture;

async function main() {
    init();
    const user = randomUUID();
    sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(user, '算法边界测试', 'unused');
    const document = title => store.normalizeDocument({ title, start_date: '2026-10-16', end_date: '2026-10-16', stops: [] }, user);
    const a = store.saveJourney(user, document('来源一'));
    const b = store.saveJourney(user, document('来源二'));
    const result = { document: document('合并结果'), sources: [{ id: a.id, revision: 1 }, { id: b.id, revision: 1 }], conflicts: [], warnings: [], total_minor: 0, preview_hash: 'a'.repeat(64), order_policy: 'constraints' };
    result.preview_hash = createHash('sha256').update(JSON.stringify({document:result.document,sources:result.sources,policy:result.order_policy,resolutions:[],conflicts:[]})).digest('hex');
    fixture = await createJourneyAlgorithmFixture();
    const legacyInput = {text:'迁移前的生成',start_date:'2026-10-16',end_date:'2026-10-16',media_ids:[]};
    const legacyRequestId=randomUUID(),legacyJobId=randomUUID(),legacyTime=new Date().toISOString();
    sql.prepare('INSERT INTO JourneyJob(id,user_id,status,input,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(legacyJobId,user,'queued',JSON.stringify(legacyInput),legacyTime,legacyTime);
    const legacyHash=createHash('sha256').update(JSON.stringify({input:legacyInput,model:'legacy-model',base:'https://legacy.invalid',vision:false})).digest('hex');
    sql.prepare('INSERT INTO JourneyJobRequest VALUES(?,?,?,?,?)').run(user,legacyRequestId,legacyHash,legacyJobId,legacyTime);
    assert.equal(ai.reserveJob(user,legacyInput,legacyRequestId).id,legacyJobId,'pre-split jobs remain replayable without exposing model configuration');
    fixture.result('merge', result);
    const previewPromise = merge.previewMerge(user, a.id, b.id, [1, 1]);
    assert.equal(typeof previewPromise?.then, 'function', 'merge planning must use the asynchronous private API');
    assert.equal((await previewPromise).preview_hash, result.preview_hash);
    assert.equal(fixture.calls.filter(c => c.operation === 'merge').length, 1);

    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    fixture.handle('merge', async () => {
        assert.equal(sql.inTransaction, false, 'network computation must not hold a SQLite transaction');
        entered();
        await wait;
        return result;
    });
    const merging = merge.mergeJourneys(user, a.id, b.id, [1, 1], { preview_hash: result.preview_hash, request_id: randomUUID() });
    await enteredPromise;
    store.saveJourney(user, document('已经更新'), a.id, 1);
    release();
    await assert.rejects(merging, error => error.status === 409);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Journey WHERE user_id=?').get(user).n, 2, 'a stale remote result must not create a diary');

    const draftId = randomUUID();
    const draft = drafts.putDraft(user, draftId, { document: document('待排序'), draft_revision: 0, base_revision: 0 });
    let rankEntered, rankRelease;
    const rankStarted = new Promise(resolve => { rankEntered = resolve; });
    const rankWait = new Promise(resolve => { rankRelease = resolve; });
    fixture.handle('rank', async () => {
        rankEntered();
        await rankWait;
        return { basis: resolution.locationBasis(draft.document), patches: [], resolution: resolution.resolutionState(draft.document), algorithm_version: 'test-v1' };
    });
    const ranking = resolution.rankDraft(user, draftId, 1);
    await rankStarted;
    drafts.putDraft(user, draftId, { document: document('排序期间更新'), draft_revision: 1, base_revision: 0 });
    rankRelease();
    await assert.rejects(ranking, error => error.status === 409);

    let canceled = false;
    fixture.handle('reconstruct', () => {
        canceled = true;
        return { document: document('迟到生成'), questions: [], resolution: { status: 'ready', questions: [] }, algorithm_version: 'test-v1' };
    });
    await assert.rejects(ai.reconstruct(user, { text: '已取消', start_date: '2026-10-16', end_date: '2026-10-16', media_ids: [] }, {
        checkActive() { if (canceled) store.fail('任务已停止', 409); }
    }), error => error.status === 409);

    const reviewDocument={...document('待确认的生成结果'),stops:[{id:randomUUID(),name:'待选店',note:'',at:'',mood:'',expenses:[],media_ids:[],lng:null,lat:null,confirmed:false,visit_status:'unknown',candidates:[],suggested_id:null,needs_choice:true}]};
    fixture.result('reconstruct',{document:reviewDocument,questions:[],resolution:{status:'needs_input',questions:[]},algorithm_version:'test-v1'});
    const generated=await ai.reconstruct(user,{text:'一碗面',start_date:'2026-10-16',end_date:'2026-10-16',media_ids:[]});
    // Only the AI-assisted label is added; everything the service returned is kept.
    assert.deepEqual(generated.document,{...reviewDocument,ai_assisted:true},'validation must preserve the review metadata expected by the unchanged frontend');
    assert.equal(fixture.calls.filter(c=>c.operation==='reconstruct').at(-1).input.amap_storage_allowed,false,'the caller storage gate must reach the private service');

    const foreign = randomUUID();
    sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(foreign, '另一个用户', 'unused');
    const mediaId = randomUUID();
    sql.prepare('INSERT INTO JourneyMedia(id,user_id,data,created_at) VALUES(?,?,?,?)').run(mediaId, foreign, Buffer.from('private'), new Date().toISOString());
    const callsBefore = fixture.calls.length;
    await assert.rejects(ai.reconstruct(user, { text: '越权图片', start_date: '2026-10-16', end_date: '2026-10-16', media_ids: [mediaId] }), error => error.status === 404);
    assert.equal(fixture.calls.length, callsBefore, 'unauthorized images must never be sent to the private service');
    console.log('Algorithm lifecycle tests passed: asynchronous planning, source/draft races, canceled results and image ownership.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (fixture) await fixture.close();
    sql.close();
    const resolved = path.resolve(temp);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('yuyuko-algorithm-lifecycle-')) fs.rmSync(resolved, { recursive: true, force: true });
});
