// Runs real React + API routes against an isolated DB, AMap SDK double and independent algorithm HTTP fixture.
const assert=require('assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {randomUUID}=require('crypto');
const express=require('express');
const jwt=require('jsonwebtoken');
const sharp=require('sharp');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'yuyuko-journey-ui-'));
process.env.DB_FILE=path.join(temp,'ui.sqlite');process.env.LOG_TO_FILE='false';process.env.LOG_TO_CONSOLE='false';
process.env.JOURNEY_LLM_API_KEY='';process.env.DEEPSEEK_API_KEY='';
process.env.AMAP_WEB_SERVICE_KEY='';process.env.JOURNEY_LLM_VISION='false';process.env.AMAP_JOURNAL_STORAGE_ALLOWED='false';process.env.AMAP_EXPORT_ALLOWED='false';
require.cache[require.resolve('../../infrastructure/redis')]={exports:{isReady:()=>false}};
const {db,init}=require('../../infrastructure/database');
const sql=db._raw;
const {createJourneyAlgorithmFixture,sealMergeSample}=require('../helpers/journeyAlgorithmFixture');
const nativeFetch=global.fetch;let browser,server,vite,stopWorker,algorithm;
async function main(){
    algorithm=await createJourneyAlgorithmFixture({capabilities:{text_ai:true}});
    algorithm.result('share',{text:'周末去了测试面馆，一碗面，一段好时光。'});
    algorithm.handle('rank',({document})=>({basis:require('../../modules/journeys/services/journeyResolution').locationBasis(document),patches:[],resolution:{status:'needs_input',questions:[]},algorithm_version:'fixture-v1'}));
    algorithm.handle('reconstruct',({input,images})=>{
        assert.equal(input.text_only,true);assert.deepEqual(images,[],'text-only requests send no image bytes');
        return {document:{title:'面馆晚饭',summary:'晚上吃了拌面。',start_date:input.start_date,end_date:input.end_date,
            entry_media_ids:input.media_ids,media_meta:{[input.media_ids[0]]:{kind:'menu',kind_source:'user'}},
            source_input:{text:input.text,start_date:input.start_date,end_date:input.end_date,center:input.center},stops:[
                {id:'ui-generated-noodle',name:'测试面馆',note:'',at:'',mood:'',media_ids:[],expenses:[],confirmed:false,visit_status:'visited',lng:null,lat:null,needs_choice:true,candidate_basis:'named',
                    excerpts:[{start:0,end:input.text.length,text:input.text}],candidates:[{id:'local_1',place_id:1,name:'测试面馆',lng:120,lat:30,source:'local',score:3,suggested:true}]}
            ]},questions:[],resolution:{status:'needs_input',questions:[]},text_only:true};
    });
    init();const id=randomUUID();sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,'浏览器测试用户','unused');
    // Preserve a previously saved opt-out while exercising the existing enable/disable flow.
    sql.prepare('UPDATE MapConsent SET feedback=0,research=0,discovery=0,version=1 WHERE user_id=?').run(id);
    sql.prepare('INSERT INTO Place(id,name,category,longitude,latitude) VALUES(1,?,?,?,?)').run('测试面馆','面食',120,30);
    sql.prepare('INSERT INTO Place(id,name,category,longitude,latitude) VALUES(2,?,?,?,?)').run('屏幕外餐馆','面食',120,30);
    sql.prepare('INSERT INTO Favorite(user_id,place_id) VALUES(?,1)').run(id);
    const token=jwt.sign({id},process.env.JWT_SECRET||'yuyuko_secret_key');
    const app=express();app.use(express.json({limit:'256kb'}));
    app.use('/api/journeys',require('../../modules/journeys/routes/journeys'));app.use('/api/public/journeys',require('../../modules/journeys/routes/publicJourneys'));
    app.use('/api/community',require('../../modules/community/routes/community'));app.use('/api/favorites',require('../../modules/preferences/routes/favorites'));app.use('/places',require('../../modules/places/routes/places'));
    const frontend=path.resolve(__dirname, '../../../frontend');
    const {createServer}=await import(require('url').pathToFileURL(path.join(frontend,'node_modules/vite/dist/node/index.js')).href);
    vite=await createServer({root:frontend,server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'warn'});
    const themeCss=(fs.readFileSync(path.join(frontend,'index.html'),'utf8').match(/:root(?:\[data-theme='dark'\])?\s*\{[^}]*\}/g)||[]).join('\n');
    app.get('/__journey_ui',async(req,res)=>res.type('html').send(await vite.transformIndexHtml(req.url,`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeCss}body{margin:0}</style></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(token)}</script><script type="module" src="/tests/integration/journey-harness.jsx"></script></body></html>`)));
    app.use(vite.middlewares);server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    stopWorker=require('../../modules/journeys/services/journeyAI').startJourneyWorker();
    const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
    const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const out=process.env.JOURNEY_UI_ARTIFACT_DIR;
    const snap=async name=>{if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,`${name}.png`)});}};
    const top=page.locator('.jw-layer.is-top');
    const count=(table,where='user_id=?')=>sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(id).n;
    const synced=()=>page.waitForFunction(()=>document.querySelector('.jw-layer.is-top .jw-header__title small')?.textContent==='草稿已同步');
    const noOverflow=async()=>{
        const wide=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth?[...document.querySelectorAll('body *')].filter(el=>!el.closest('.jw-layer:not(.is-top)')).filter(el=>el.getBoundingClientRect().right>window.innerWidth+1).slice(0,5).map(el=>`${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().right)}`):[]);
        assert.deepEqual(wide,[],'no horizontal overflow at phone width');
    };
    const openEntry=async()=>{await page.getByRole('button',{name:'打开日记入口'}).click();await page.getByRole('menu',{name:'日记 · 同好'}).waitFor();await page.waitForTimeout(300);};
    const picker=page.getByTestId('fake-map-picker');
    const stopNames=()=>top.locator('.jw-stop').evaluateAll(list=>list.map(el=>el.getAttribute('aria-label').replace(/^第 \d+ 站 /,'')));
    const closeAll=async()=>{for(let i=0;i<6&&await page.locator('.jw-layer').count();i++){await page.keyboard.press('Escape');await page.waitForTimeout(250);}};
    await page.goto(`http://127.0.0.1:${server.address().port}/__journey_ui`);
    // A cold Vite instance may reload once after optimizing dependencies.
    await page.waitForLoadState('networkidle');await page.waitForTimeout(800);await page.waitForLoadState('networkidle');

    // --- Entry sheet: three destinations in order, independent cancel. ---
    await openEntry();
    assert.deepEqual(await page.locator('.jw-entry-sheet__text strong').allInnerTexts(),['图文生成','日历','同好']);
    await snap('entry-sheet-desktop');
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('button',{name:'✦ 日记 · 同好'}).waitFor();

    // --- Manual diary: edit, autosave, restore from 未完成. ---
    await openEntry();await page.getByRole('menuitem',{name:/日历/}).click();
    await top.getByRole('button',{name:'手动新建'}).click();
    await top.getByLabel('标题',{exact:true}).fill('周末的面食散步');
    assert.equal(await top.getByRole('button',{name:'＋ 添加一站'}).count(),0,'stops are added from the map, below an existing stop');
    await top.getByRole('button',{name:'＋ 在地图上添加地点'}).click();
    await picker.getByText('添加地点').waitFor();
    await picker.getByRole('button',{name:'选择测试面馆'}).click();
    await top.getByRole('button',{name:'✓ 已核对'}).waitFor();
    await top.locator('summary',{hasText:'补充信息'}).first().click();
    await top.getByLabel('第 1 站的文字').fill('和朋友吃了一碗面，聊了很多。');
    await top.getByRole('button',{name:'＋ 记一笔'}).click();
    await top.getByLabel('第 1 站支出 1 金额').fill('28.50');
    await top.getByLabel('第 1 站支出 1 说明').fill('晚饭');
    await synced();
    assert.equal(count('Journey'),0);assert.equal(count('JourneyDraft',"user_id=? AND status='active'"),1);
    await page.reload();
    await openEntry();await page.getByRole('menuitem',{name:/日历/}).click();
    await top.getByRole('button',{name:'未完成 · 1'}).click();
    await top.getByRole('button',{name:'继续编辑：周末的面食散步'}).click();
    await top.locator('summary',{hasText:'补充信息'}).first().click();
    assert.equal(await top.getByLabel('第 1 站支出 1 金额').inputValue(),'28.50');
    assert.equal(await top.getByLabel('第 1 站的文字').inputValue(),'和朋友吃了一碗面，聊了很多。');

    // --- Offline autosave, uncertain acknowledgements and leave protection. ---
    const draftUrl=/\/api\/journeys\/drafts\/[^/]+$/;
    await page.route(draftUrl,route=>route.request().method()==='PUT'?route.abort('failed'):route.continue());
    await top.getByLabel('第 1 站的文字').fill('断网期间继续记录。');
    await top.getByText('草稿尚未同步，将自动重试',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>window.__TEST_LEAVE()),false,'navigation is blocked while latest edits cannot be saved');
    await page.unroute(draftUrl);
    let draftAckLost=false;
    await page.route(draftUrl,async route=>{if(route.request().method()==='PUT'&&!draftAckLost){draftAckLost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    for(let i=0;i<20&&!draftAckLost;i++)await page.waitForTimeout(100);
    assert.equal(draftAckLost,true);
    await top.getByLabel('第 1 站的文字').fill('响应丢失期间仍可继续补充。');
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await synced();await page.unroute(draftUrl);
    assert.equal(await top.getByLabel('第 1 站的文字').inputValue(),'响应丢失期间仍可继续补充。');
    await top.getByLabel('第 1 站的文字').fill('和朋友吃了一碗面，聊了很多。');
    assert.equal(await page.evaluate(()=>window.__TEST_LEAVE()),true,'navigation flushes without waiting for debounce');

    // --- Private save whose acknowledgement is lost: the retry reuses the request and saves once. ---
    await top.getByRole('radio',{name:'私密'}).click();
    let commitAckLost=false;
    await page.route('**/api/journeys/drafts/*/commit',async route=>{if(!commitAckLost){commitAckLost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
    await page.getByRole('button',{name:'保存为私密'}).click();
    await top.getByText('保存结果待确认',{exact:false}).first().waitFor();
    await page.getByRole('button',{name:'保存为私密'}).click();
    await top.getByText('已保存，仅自己可见').waitFor();
    await page.unroute('**/api/journeys/drafts/*/commit');
    assert.equal(count('Journey'),1);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n,2,'private saves create no markers');
    await snap('detail-private-desktop');

    // --- Share export stays separate from public reading and excludes private money. ---
    await top.getByRole('button',{name:'生成分享图文'}).click();
    await top.getByRole('button',{name:'生成贴文与首图'}).click();
    await top.getByAltText('行程分享首图预览').waitFor();
    assert.ok(!(await top.getByLabel('贴文（可以直接修改）').inputValue()).includes('28.5'));
    await top.getByLabel('首图风格').selectOption('夜色');
    await top.getByRole('button',{name:'更新首图预览'}).click();
    await top.getByRole('button',{name:'返回',exact:true}).click();

    // --- Publish an existing private diary through the edit flow; the preview shows the map action. ---
    await top.getByRole('button',{name:'修改',exact:true}).click();
    await top.getByRole('heading',{name:'修改日记'}).waitFor();
    await top.getByRole('radio',{name:'公开'}).click();
    await top.getByText('公开 · 关联 1 个已有标记，创建 0 个新标记').waitFor();
    await top.getByText('查看将公开的内容').click();
    assert.ok(!(await top.locator('.jw-public-preview').innerText()).includes('28.5'));
    await snap('review-public-preview-desktop');
    await page.getByRole('button',{name:'保存并公开'}).click();
    await top.getByText('已公开 · 已关联 1 个地点').first().waitFor();
    assert.equal(count('JourneyPublication',"user_id=? AND status='active'"),1);

    // --- From a place to its diaries, into the public diary, back to the marker. ---
    await closeAll();
    await page.getByRole('button',{name:'打开测试面馆详情'}).click();
    const diaries=page.getByRole('region',{name:'相关日记'});
    await diaries.getByText('周末的面食散步').waitFor();
    await diaries.getByText('和朋友吃了一碗面，聊了很多。').waitFor();
    await snap('place-detail-diaries-desktop');
    await diaries.getByRole('button',{name:'查看完整日记'}).click();
    await top.getByRole('heading',{name:'周末的面食散步'}).waitFor();
    assert.ok(!(await top.innerText()).includes('28.5'),'public diary never shows private expenses');
    await top.getByRole('button',{name:'查看地图标记'}).click();
    await page.getByText('已定位地图标记 1').waitFor();
    await page.keyboard.press('Escape');
    await page.route('**/places/1/diaries*',async route=>{await new Promise(r=>setTimeout(r,1500));await route.continue().catch(()=>{});});
    await page.getByRole('button',{name:'打开测试面馆详情'}).click();
    await page.getByRole('button',{name:'切换到屏幕外餐馆'}).click();
    await page.getByRole('region',{name:'相关日记'}).getByText('还没有相关日记',{exact:false}).waitFor();
    await page.waitForTimeout(1800);
    assert.equal(await page.getByRole('region',{name:'相关日记'}).getByText('周末的面食散步').count(),0,'a late response for the previous place is ignored');
    await page.unroute('**/places/1/diaries*');
    await page.keyboard.press('Escape');await page.waitForTimeout(300);

    // --- A second overlapping diary keeps the same expense identity; merge resolves it explicitly. ---
    const first=sql.prepare('SELECT * FROM Journey WHERE user_id=? ORDER BY created_at LIMIT 1').get(id);
    const duplicate={...JSON.parse(first.document),title:'午后补记'};
    duplicate.stops[0].expenses[0].amount=38.5;
    const duplicateJourney=require('../../modules/journeys/services/journeyStore').saveJourney(id,duplicate);
    const mergeDocument={...duplicate,title:'周末的面食散步 · 午后补记',stops:[{...JSON.parse(first.document).stops[0],id:'ui-merged-first'},
        {...duplicate.stops[0],id:'ui-merged-second',expenses:[{...duplicate.stops[0].expenses[0],id:'ui-separate-expense'}]}]};
    const mergeSample={document:mergeDocument,sources:[{id:first.id,revision:first.revision},{id:duplicateJourney.id,revision:1}],warnings:[],total_minor:6700,order_policy:'constraints'};
    algorithm.handle('merge',({options})=>sealMergeSample(options?.expense_resolutions?.[duplicate.stops[0].expenses[0].id]==='separate'
        ?{...structuredClone(mergeSample),conflicts:[],preview_hash:'4'.repeat(64)}
        :{...structuredClone(mergeSample),preview_hash:'5'.repeat(64),conflicts:[{type:'expense',id:duplicate.stops[0].expenses[0].id,message:'请选择这笔支出的保留方式',
            options:[{ref:'first-expense',title:'周末的面食散步',place:'测试面馆',amount:28.5},{ref:'second-expense',title:'午后补记',place:'测试面馆',amount:38.5}]}]},options?.expense_resolutions));
    await openEntry();await page.getByRole('menuitem',{name:/日历/}).click();
    await top.getByRole('button',{name:'管理',exact:true}).click();
    await top.getByLabel('选择 周末的面食散步 以合并',{exact:true}).check();
    await top.getByLabel('选择 午后补记 以合并',{exact:true}).check();
    await top.getByRole('button',{name:'预览合并',exact:true}).click();
    await top.getByRole('combobox',{name:/^这笔支出如何保留/}).waitFor();
    assert.equal(await top.getByRole('button',{name:'确认合并',exact:true}).isDisabled(),true);
    await top.getByRole('combobox',{name:/^这笔支出如何保留/}).selectOption('separate');
    await top.getByText('合计 ¥67.00',{exact:true}).waitFor();
    await top.getByRole('button',{name:'确认合并',exact:true}).click();
    await top.getByText('已合并为一篇新的私密日记',{exact:false}).waitFor();
    assert.equal(count('Journey'),3);assert.equal(count('JourneyPublication',"user_id=? AND status='active'"),1,'merging never publishes');

    // --- Withdraw from the detail page: the place card stops listing it immediately. ---
    await top.getByRole('button',{name:'返回',exact:true}).click();
    await top.getByRole('button',{name:/^周末的面食散步 .*公开$/}).click();
    await top.getByRole('button',{name:'更多操作'}).click();
    await page.getByRole('menuitem',{name:'改为私密'}).click();
    await page.getByRole('alertdialog').getByRole('button').last().click();
    await top.getByText('已改为私密，公开内容已撤下。').waitFor();
    assert.equal((await page.evaluate(()=>fetch('/places/1/diaries').then(r=>r.json()))).total,0);
    await closeAll();

    // --- Review #8: a lost material-save response is replayed, not reported as a conflict. ---
    await openEntry();await page.getByRole('menuitem',{name:/图文生成/}).click();
    const composeUrl='**/api/journeys/compose-drafts/*';
    let composeAckLost=false;
    await page.route(composeUrl,async route=>{if(route.request().method()==='PUT'&&!composeAckLost){composeAckLost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
    await top.getByLabel('说说这顿饭或这一天').fill('第一版已经抵达服务器');
    await top.getByText('同步失败',{exact:false}).waitFor();
    await top.getByLabel('说说这顿饭或这一天').fill('丢失响应后又补写了第二版');
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.querySelector('[aria-label="素材保存状态"]')?.textContent.includes('已同步'));
    assert.equal(composeAckLost,true);assert.equal(await top.getByText('冲突待处理',{exact:false}).count(),0);
    await page.unroute(composeUrl);
    assert.equal(JSON.parse(sql.prepare("SELECT payload FROM JourneyComposeDraft WHERE user_id=? AND status='active' ORDER BY updated_at DESC").get(id).payload).text,'丢失响应后又补写了第二版');

    // --- Review #7: moving the pin and confirming at once saves the new coordinates without the old address. ---
    await top.getByRole('button',{name:'设置地址（搜索中心）'}).click();
    await page.getByRole('button',{name:'在地图上选择'}).click();
    await picker.getByText('选择搜索中心').waitFor();
    await picker.getByRole('button',{name:'选图钉位置'}).click();
    await top.getByRole('button',{name:'设置地址（搜索中心）'}).getByText('测试大学城',{exact:false}).waitFor();
    const readCenter=()=>JSON.parse(sql.prepare("SELECT payload FROM JourneyComposeDraft WHERE user_id=? AND status='active' ORDER BY updated_at DESC").get(id).payload).center;
    for(let i=0;i<30&&readCenter()?.name!=='测试大学城';i++)await page.waitForTimeout(200);
    const movedCenter=readCenter();
    assert.deepEqual([movedCenter.lng,movedCenter.lat,movedCenter.name,movedCenter.city,movedCenter.source],[121,31,'测试大学城','测试市','map']);
    await top.getByRole('button',{name:'返回',exact:true}).click();

    // --- Review #2: material saved only on this device stays reachable, even when the server list fails. ---
    await openEntry();await page.getByRole('menuitem',{name:/图文生成/}).click();
    await page.route(composeUrl,route=>route.request().method()==='PUT'?route.abort('failed'):route.continue());
    await top.getByLabel('说说这顿饭或这一天').fill('只在本机保存的奶茶记录');
    await top.getByText('同步失败',{exact:false}).waitFor();
    await top.getByRole('button',{name:'返回',exact:true}).click();
    await page.route('**/api/journeys/unfinished',route=>route.abort('failed'));
    await openEntry();await page.getByRole('menuitem',{name:/日历/}).click();
    await top.getByRole('button',{name:/^未完成 · \d/}).click();
    await top.getByText('暂时无法读取',{exact:false}).waitFor();
    await top.getByRole('button',{name:'继续：只在本机保存的奶茶记录'}).click();
    assert.equal(await top.getByLabel('说说这顿饭或这一天').inputValue(),'只在本机保存的奶茶记录');
    await page.unroute('**/api/journeys/unfinished');await page.unroute(composeUrl);
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.querySelector('[aria-label="素材保存状态"]')?.textContent.includes('已同步'));
    await closeAll();
    // Keep the later counts exact: discard the probe materials.
    sql.prepare("UPDATE JourneyComposeDraft SET status='discarded',payload='{}' WHERE user_id=? AND status='active'").run(id);

    // --- Composer: photo queue, explicit text-only generation, one review draft, public save. ---
    const photos=await Promise.all(['#e07050','#70a0e0'].map(async(c,i)=>({name:`food${i}.jpg`,mimeType:'image/jpeg',buffer:await sharp({create:{width:480,height:320,channels:3,background:c}}).jpeg().toBuffer()})));
    await openEntry();await page.getByRole('menuitem',{name:/图文生成/}).click();
    const chooser=page.waitForEvent('filechooser');
    await top.getByRole('button',{name:'添加图片'}).click();
    await page.getByRole('menuitem',{name:'从相册选择'}).click();
    await (await chooser).setFiles(photos);
    await page.waitForFunction(()=>document.querySelectorAll('.jw-layer.is-top .jw-thumb:not(.jw-thumb--add)').length===2&&!document.querySelector('.jw-layer.is-top .jw-thumb__status'));
    await top.getByRole('button',{name:/第 2 张图片/}).click();
    await page.getByRole('button',{name:'前移'}).click();
    await page.getByRole('radio',{name:'菜单'}).click();
    await page.keyboard.press('Escape');
    assert.equal(await top.getByRole('button',{name:'生成行程草稿'}).count(),0,'without vision the photo path is an explicit choice');
    await top.getByLabel('说说这顿饭或这一天').fill('晚上在测试面馆吃了招牌拌面，面很筋道。');
    await page.waitForFunction(()=>document.querySelector('[aria-label="素材保存状态"]')?.textContent.includes('已同步'));
    const composeRow=sql.prepare("SELECT payload FROM JourneyComposeDraft WHERE user_id=? AND status='active'").get(id);
    const composePayload=JSON.parse(composeRow.payload);
    assert.equal(composePayload.media_ids.length,2);assert.equal(composePayload.media_notes[composePayload.media_ids[0]].kind,'menu','reordered photo keeps its tag');
    assert.equal(composePayload.intended_visibility,'public');
    await snap('composer-desktop');
    await top.getByRole('button',{name:'仅根据描述生成'}).click();
    await top.getByRole('heading',{name:'核对行程'}).waitFor({timeout:20000});
    assert.equal(count('JourneyDraft',"user_id=? AND status='active' AND compose_draft_id IS NOT NULL"),1);
    assert.equal(await top.locator('[aria-label="本篇照片"] .jw-entry-photo').count(),2,'every photo stays with the entry');
    // The quoted source sentence is shown in an editable box; unchanged text stays a source excerpt.
    assert.equal(await top.getByLabel('第 1 站的文字').inputValue(),'晚上在测试面馆吃了招牌拌面，面很筋道。');
    await top.locator('.jw-stop').first().getByText('原文摘录',{exact:false}).waitFor();
    const genText=top.getByLabel('第 1 站的文字');
    await genText.fill('面很筋道，下次还来。');
    await top.locator('.jw-stop').first().getByText('作者编辑',{exact:false}).waitFor();
    await top.getByRole('button',{name:'恢复原文摘录'}).click();
    assert.equal(await genText.inputValue(),'晚上在测试面馆吃了招牌拌面，面很筋道。');
    // Clearing the box returns the sentence to the unassigned source text, from where it can be assigned again.
    await genText.fill('');
    await top.getByText('待归属的原文（2 句）').click();
    for(let i=0;i<2;i++)await top.getByRole('combobox',{name:/^把“.*”归到某一站$/}).first().selectOption({label:'1. 测试面馆'});
    assert.equal(await genText.inputValue(),'晚上在测试面馆吃了招牌拌面，面很筋道。');
    assert.equal(await top.getByText('待归属的原文',{exact:false}).count(),0);
    assert.deepEqual(await stopNames(),['测试面馆'],'the review shows the finished service response');
    // The remote sample requires explicit place confirmation before publication.
    assert.equal(await top.getByText('尚未定位',{exact:false}).count(),1);
    await top.getByRole('button',{name:'选择店铺',exact:true}).click();
    await page.getByRole('list',{name:'候选店铺'}).getByRole('button',{name:/测试面馆/}).click();
    await top.getByRole('button',{name:'✓ 已核对'}).waitFor();
    await top.getByText('公开 · 关联 1 个已有标记，创建 0 个新标记').waitFor();
    await page.getByRole('button',{name:'保存并公开'}).click();
    await top.getByText('已公开 · 已关联 1 个地点').first().waitFor();
    assert.equal(count('JourneyComposeDraft',"user_id=? AND status='active'"),0,'the material draft closes with the save');
    assert.equal((await page.evaluate(()=>fetch('/places/1/diaries').then(r=>r.json()))).total,1);
    await closeAll();

    // --- Review page: full-screen map picking, add below, reorder, remove; older private notes are kept. ---
    const store=require('../../modules/journeys/services/journeyStore'),draftStore=require('../../modules/journeys/services/journeyDrafts');
    sql.prepare('INSERT INTO Place(id,name,longitude,latitude) VALUES(3,?,80,30)').run('同名面馆');
    sql.prepare('INSERT INTO Place(id,name,longitude,latitude) VALUES(4,?,120,30)').run('同名面馆');
    const resolutionDoc=store.normalizeDocument({title:'地图选点回归',start_date:'2026-09-16',end_date:'2026-09-16',summary:'',stops:[
        {id:randomUUID(),name:'同名面馆',lng:null,lat:null,confirmed:false,visit_status:'unknown',note:'原始描述',candidates:[{id:'local_3',place_id:3,name:'同名面馆',lng:80,lat:30,source:'local',score:3},{id:'local_4',place_id:4,name:'同名面馆',lng:120,lat:30,source:'local',score:3}]},
        {id:randomUUID(),name:'固定锚点',lng:120.01,lat:30,confirmed:true,visit_status:'visited'}
    ]},id);
    draftStore.putDraft(id,randomUUID(),{document:resolutionDoc,draft_revision:0,base_revision:0});
    await openEntry();await page.getByRole('menuitem',{name:/日历/}).click();
    await top.getByRole('button',{name:/未完成 · /}).click();
    await top.getByRole('button',{name:'继续编辑：地图选点回归'}).click();
    const card=top.locator('.jw-stop').first();
    for(const gone of ['补充线索','已到访','仅提及','待确定','清除位置'])assert.equal(await card.getByRole('button',{name:gone}).count()+await card.getByRole('radio',{name:gone}).count(),0,`${gone} is no longer offered`);
    assert.equal(await card.getByText('在公开日记中显示这一站',{exact:false}).count(),0);
    assert.equal(await card.getByText('经历描述',{exact:false}).count(),0);
    // An AMap result without storage permission is refused and changes nothing.
    await card.getByRole('button',{name:'地图选点'}).click();
    await picker.getByText('为「同名面馆」选择地点').waitFor();
    await picker.getByRole('button',{name:'选择高德地点'}).click();
    await top.getByText('高德地点尚未配置存储授权',{exact:false}).waitFor();
    assert.deepEqual(await stopNames(),['同名面馆','固定锚点']);
    await card.getByRole('button',{name:'地图选点'}).click();
    await picker.getByRole('button',{name:'选择测试面馆'}).click();
    await top.locator('.jw-stop').first().getByRole('button',{name:'✓ 已核对'}).waitFor();
    // Adding below the anchor opens the picker at the anchor; the pin's address arrives later and is attached.
    await top.locator('.jw-stop').nth(1).getByRole('button',{name:'在下方添加地点'}).click();
    await picker.getByText('中心：120.01,30').waitFor();
    await picker.getByRole('button',{name:'选图钉位置'}).click();
    const added=top.locator('.jw-stop').nth(2);
    await added.getByText('测试省测试市测试区大学城路 1 号').waitFor();
    await added.getByLabel('店名 / 地点名称').fill('路边糖水摊');
    assert.deepEqual(await stopNames(),['测试面馆','固定锚点','路边糖水摊']);
    await added.getByRole('button',{name:'往前一站'}).click();
    assert.deepEqual(await stopNames(),['测试面馆','路边糖水摊','固定锚点']);
    await top.locator('.jw-stop').nth(1).getByRole('button',{name:'移除此站'}).click();
    await page.getByRole('alertdialog').getByRole('button').last().click();
    assert.deepEqual(await stopNames(),['测试面馆','固定锚点']);
    // Escape closes only the picker; nothing is added.
    await top.locator('.jw-stop').nth(1).getByRole('button',{name:'在下方添加地点'}).click();
    await picker.waitFor();await page.keyboard.press('Escape');await picker.waitFor({state:'detached'});
    assert.deepEqual(await stopNames(),['测试面馆','固定锚点']);
    await top.getByRole('heading',{name:'核对行程'}).waitFor();
    await page.getByRole('button',{name:'保存为私密'}).click();
    await top.getByText('已保存，仅自己可见').waitFor();
    const resolved=JSON.parse(sql.prepare("SELECT document FROM Journey WHERE user_id=? AND json_extract(document,'$.title')='地图选点回归'").get(id).document);
    assert.equal(resolved.stops.length,2);
    assert.deepEqual([resolved.stops[0].place_id,resolved.stops[0].name,resolved.stops[0].confirmed,resolved.stops[0].visit_status],[1,'测试面馆',true,'visited']);
    assert.equal(resolved.stops[0].note,'原始描述','an older private note is kept even though it is no longer edited here');
    assert.equal(resolved.stops[1].lng,120.01);
    await closeAll();

    // --- 同好: collections and discovery settings as in-page sections. ---
    await openEntry();await page.getByRole('menuitem',{name:/同好/}).click();
    await top.getByRole('tab',{name:'我的公开收藏夹'}).click();
    await top.getByRole('button',{name:'＋ 新建收藏夹'}).click();
    await top.getByLabel('收藏夹名称').fill('我的面食地图');
    await top.getByLabel('测试面馆',{exact:true}).check();
    await top.getByLabel('公开此收藏夹').check();
    await top.getByRole('button',{name:'保存收藏夹'}).click();
    await top.getByText('收藏夹已保存').waitFor();
    await top.getByRole('tab',{name:'发现设置'}).click();
    await top.getByLabel('记录搜索操作',{exact:false}).check();
    await top.getByRole('button',{name:'保存设置'}).click();
    await top.getByText('设置已保存').waitFor();
    assert.equal(sql.prepare('SELECT feedback FROM MapConsent WHERE user_id=?').get(id).feedback,1);
    // Feedback collection is independent of the diary pages: exposure needs 800 ms of real visibility.
    await closeAll();
    for(let i=0;i<24;i++){if(count('MapInteraction',"user_id=? AND kind='exposure'"))break;await page.waitForTimeout(250);}
    assert.equal(count('MapInteraction',"user_id=? AND kind='exposure' AND place_id=1"),1);
    assert.equal(count('MapInteraction',"user_id=? AND kind='exposure' AND place_id=2"),0);
    // Vector-only neighbours are listed first; the star map is a separate view.
    const peer=randomUUID();sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(peer,'只有向量的同好','unused');
    const {EMBEDDING_MODEL,EMBEDDING_DIMENSIONS}=require('../../infrastructure/aiClients');
    const {ALGORITHM_VERSION}=require('../../modules/preferences/services/userPreferenceService');
    const embedding=new Float32Array(EMBEDDING_DIMENSIONS);embedding[0]=1;
    for(const userId of [id,peer])sql.prepare(`INSERT OR REPLACE INTO UserPreference
        (user_id,vector,model,dimensions,algorithm_version,status,source_place_count,vector_place_count,total_weight,updated_at,dirty)
        VALUES(?,?,?,?,?,'ready',1,1,5,?,0)`).run(userId,Buffer.from(embedding.buffer),EMBEDDING_MODEL,EMBEDDING_DIMENSIONS,ALGORITHM_VERSION,Date.now());
    await openEntry();await page.getByRole('menuitem',{name:/同好/}).click();
    await top.getByText('同好发现已关闭').waitFor();
    await top.getByRole('button',{name:'前往发现设置'}).click();
    await top.getByLabel('允许使用我的用户向量匹配同好',{exact:false}).check();
    await top.getByRole('button',{name:'保存设置'}).click();
    await top.getByRole('tab',{name:'同好'}).click();
    await top.getByRole('button',{name:/只有向量的同好.*向量相似度 100%/}).click();
    await top.getByText('对方还没有公开收藏夹。').waitFor();
    await top.getByRole('radio',{name:'星图'}).click();
    await top.getByRole('img',{name:'以我为中心的偏好星图'}).waitFor();

    // --- Phone width: full-screen pages without horizontal overflow, dark theme included. ---
    await closeAll();
    await page.setViewportSize({width:390,height:844});
    await openEntry();await noOverflow();await snap('entry-sheet-mobile');
    await page.getByRole('menuitem',{name:/图文生成/}).click();await noOverflow();await snap('composer-mobile');
    await top.getByRole('button',{name:'返回'}).click();
    await openEntry();await page.getByRole('menuitem',{name:/日历/}).click();await noOverflow();
    await page.evaluate(()=>window.__TEST_THEME(true));await snap('calendar-dark-mobile');await page.evaluate(()=>window.__TEST_THEME(false));
    await top.locator('.jw-entry',{hasText:'面馆晚饭'}).click();await top.getByRole('button',{name:'修改',exact:true}).click();
    await top.getByRole('heading',{name:'修改日记'}).waitFor();await noOverflow();await snap('review-mobile');
    assert.ok(algorithm.calls.some(c=>c.operation==='reconstruct'));assert.ok(algorithm.calls.some(c=>c.operation==='share'));
    assert.deepEqual(errors,[]);
    console.log('Browser journey tests passed: entry sheet, full-screen composer, photo queue, text-only generation, review, private/public save, share, place diaries, public reader, withdrawal, merge, map picking, add-below/reorder/remove, community and phone layout, plus review regressions #2 #3 #6 #7 #8 #11.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
    global.fetch=nativeFetch;if(stopWorker)stopWorker();if(browser)await browser.close();if(vite)await vite.close();if(server)await new Promise(r=>server.close(r));if(algorithm)await algorithm.close();db._raw.close();
    const resolved=path.resolve(temp);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('yuyuko-journey-ui-'))fs.rmSync(resolved,{recursive:true,force:true});
});
