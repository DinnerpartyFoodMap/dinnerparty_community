// Real React panel + authenticated API + configured numeric HTTP service, temporary DB only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
const express=require('express'),jwt=require('jsonwebtoken');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rating-ui-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false',PLACE_RATING_DAILY_LIMIT:'1'});
require.cache[require.resolve('../../infrastructure/redis')]={exports:{isReady:()=>false}};
const {db,init}=require('../../infrastructure/database');let server,vite,browser;
async function main(){
    init();for(const id of ['creator','viewer'])db._raw.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'unused');
    db._raw.prepare("INSERT INTO Place(id,name,creator_id,moderation_status) VALUES(1,'评分回归地点','creator','visible')").run();
    require('../../modules/ratings/services/placeRatings').insertCreationRating(1,'creator',4);
    const app=express(),requests=[];app.use(express.json());app.use('/api/ratings',(req,_res,next)=>{if(req.method==='PUT')requests.push(req.body);next();},require('../../modules/ratings/routes/placeRatings'));
    const frontend=path.resolve(__dirname,'../../../frontend'),{createServer}=await import(pathToFileURL(path.join(frontend,'node_modules/vite/dist/node/index.js')).href);
    vite=await createServer({root:frontend,server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'warn'});
    const token=jwt.sign({id:'viewer'},process.env.JWT_SECRET||'yuyuko_secret_key');
    app.get('/__rating_ui',async(req,res)=>res.type('html').send(await vite.transformIndexHtml(req.url,`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(token)}</script><script type="module" src="/tests/integration/rating-harness.jsx"></script></body></html>`)));
    app.use(vite.middlewares);server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
    for(const viewport of [{width:1100,height:850},{width:390,height:844}]){
        const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
        await page.goto(`http://127.0.0.1:${server.address().port}/__rating_ui`);
        await page.waitForFunction(()=>JSON.parse(document.querySelector('#rating-state').textContent)?.summary);
        const panel=page.getByRole('dialog'),radios=panel.getByRole('radio');assert.equal(await radios.count(),4);assert.equal(await panel.locator('input,textarea').count(),0);
        const choice=radios.nth(1),save=async()=>{const response=page.waitForResponse(r=>r.url().includes('/api/ratings/places/1')&&r.request().method()==='PUT');await choice.click();assert.equal((await response).status(),200);await page.waitForFunction(()=>!document.querySelector('[role="radio"][aria-checked="true"]')?.disabled);};
        await save();await page.waitForFunction(()=>JSON.parse(document.querySelector('#rating-state').textContent)?.mine?.score===3);
        const before=db._raw.prepare("SELECT * FROM PlaceRating WHERE user_id='viewer'").get(),quota=db._raw.prepare("SELECT COUNT(*) AS n FROM PlaceRatingEvent WHERE user_id='viewer'").get().n;
        let revisions=db._raw.prepare("SELECT COUNT(*) AS n FROM RatingRevision WHERE user_id='viewer'").get().n;
        await save();assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM RatingRevision WHERE user_id='viewer'").get().n,++revisions);
        const tips=await page.evaluate(()=>window.__TEST_TIPS.length);
        await page.route('**/api/ratings/places/1',async route=>{assert.equal((await route.fetch()).status(),200);await route.abort('failed');},{times:1});
        await choice.click();await page.waitForFunction(n=>window.__TEST_TIPS.length>n,tips);
        const lost=requests.at(-1).request_id;assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM RatingRevision WHERE user_id='viewer'").get().n,++revisions);
        await save();assert.equal(requests.at(-1).request_id,lost,'a retry after losing a committed response keeps the same command ID');
        assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM RatingRevision WHERE user_id='viewer'").get().n,revisions,'the lost response retry does not add another confirmation');
        await save();assert.notEqual(requests.at(-1).request_id,lost,'a later click starts a new confirmation');
        assert.deepEqual(db._raw.prepare("SELECT * FROM PlaceRating WHERE user_id='viewer'").get(),before);
        assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM PlaceRatingEvent WHERE user_id='viewer'").get().n,quota);assert.deepEqual(errors,[]);await page.close();
    }
    console.log('Rating browser tests passed on desktop and mobile: four choices, same-score confirmation, unchanged vote/quota, lost response retry and new-click identity.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
    if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(vite)await vite.close();
    require('../../modules/preferences/services/userPreferenceService').startUserVectorWorker()();db._raw.close();fs.rmSync(temp,{recursive:true,force:true});
});
