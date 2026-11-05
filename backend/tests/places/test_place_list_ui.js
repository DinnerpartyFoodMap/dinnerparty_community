const assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
let browser,server,vite;
async function main(){
 const express=require('express'),app=express(),frontend=path.resolve(__dirname,'../../../frontend');
 const {createServer}=await import(pathToFileURL(path.join(frontend,'node_modules/vite/dist/node/index.js')).href);
 vite=await createServer({root:frontend,server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'warn'});
 let broken=false;const requests=[];
 app.get('/places/list',(req,res)=>{
  const offset=Number(req.query.offset),snapshot=req.query.snapshot;requests.push({offset,snapshot});
  if(snapshot==='expired'||broken&&requests.length>1)return res.status(409).json({error:'列表已更新，请重新加载'});
  const refreshed=requests.length>1,base=refreshed?100:0;
  res.json({items:Array.from({length:20},(_,n)=>({id:base+offset+n+1,name:`店铺 ${base+offset+n+1}`,rating_count:0})),total:40,snapshot:refreshed?'fresh':'expired'});
 });
 app.get('/__place_list_ui',async(req,res)=>res.type('html').send(await vite.transformIndexHtml(req.url,'<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/tests/integration/place-list-harness.jsx"></script></body></html>')));
 app.use(vite.middlewares);server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 browser=await require(process.env.PLAYWRIGHT_MODULE||'playwright').chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const open=()=>page.goto(`http://127.0.0.1:${server.address().port}/__place_list_ui`);
 await open();await page.getByText('店铺 1',{exact:true}).waitFor();
 await page.getByRole('button',{name:'加载更多',exact:true}).click();
 await page.getByText('店铺 101',{exact:true}).waitFor();
 assert.equal(await page.getByText('店铺 1',{exact:true}).count(),0,'fresh ranking replaces old rows');
 assert.deepEqual(requests,[{offset:0,snapshot:undefined},{offset:20,snapshot:'expired'},{offset:0,snapshot:undefined}]);
 await page.getByRole('button',{name:'加载更多',exact:true}).click();
 await page.getByText('店铺 140',{exact:true}).waitFor();
 assert.equal(await page.locator('.fm-place-list__grid > li').count(),40,'no duplicates or omitted page after restart');
 assert.deepEqual(requests.at(-1),{offset:20,snapshot:'fresh'});
 requests.length=0;broken=true;await open();await page.getByText('店铺 1',{exact:true}).waitFor();
 await page.getByRole('button',{name:'加载更多',exact:true}).click();
 await page.getByRole('alert').waitFor();
 assert.equal(requests.length,3,'persistent conflicts stop after one automatic restart');
 broken=false;await page.getByRole('button',{name:'重试',exact:true}).click();
 await page.getByText('店铺 101',{exact:true}).waitFor();assert.deepEqual(requests.at(-1),{offset:0,snapshot:undefined});
 assert.deepEqual(errors,[]);console.log('Place list UI passed: snapshot recovery, replacement, subsequent paging and bounded conflict retry.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await vite?.close();});
