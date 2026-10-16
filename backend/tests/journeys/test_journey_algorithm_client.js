const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-algorithm-client-'));
process.env.DB_FILE = path.join(temporary, 'places.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
const savedEnvironment = Object.fromEntries(['JOURNEY_ALGORITHM_SERVICE_URL', 'JOURNEY_ALGORITHM_SERVICE_TOKEN',
    'JOURNEY_ALGORITHM_TIMEOUT_MS', 'JOURNEY_ALGORITHM_CALLBACK_TOKEN'].map(key => [key, process.env[key]]));
const nativeFetch = global.fetch;
let upstream, callbackServer, sql;
let upstreamHandler;
const received = [];
const unavailable = {text_ai:false, vision_ai:false, amap_search:false, amap_export:false, version:null};
const candidate = {id:'local_1', place_id:1, name:'面馆', address:'杭州', lng:120, lat:30, source:'local', score:3, geo_ok:true};
const document = {title:'午饭', summary:'面条', start_date:'2026-10-16', end_date:'2026-10-16', stops:[
    {id:'stop_1', name:'面馆', lng:120, lat:30, candidates:[candidate], expenses:[], visit_status:'visited', confirmed:false}
]};
const rank = {basis:'[["stop_1"]]', patches:[{stop_id:'stop_1', candidate_basis:'named', candidates:[{...candidate,suggested:true}], suggested_id:'local_1'}],
    resolution:{status:'needs_input',questions:[{stop_id:'stop_1',prompt:'核对位置'}]}, algorithm_version:'test-v1'};
const merge = {document, sources:[{id:'journey_a',revision:1},{id:'journey_b',revision:2}], conflicts:[], warnings:[],
    total_minor:0, preview_hash:'a'.repeat(64), order_policy:'constraints'};
const clarify = {...rank, kind:'clarification', draft_id:'draft_1', draft_revision:1, answer:{stop_id:'stop_1',text:'在杭州',city:'杭州'}};
const results = {reconstruct:{document,questions:[],resolution:rank.resolution,algorithm_version:'test-v1'}, search:[candidate], rank, merge, clarify, share:{text:'一碗面。'}};

function json(res, status, body) {
    res.writeHead(status, {'Content-Type':'application/json'});
    res.end(JSON.stringify(body));
}
async function listen(server) {
    await new Promise((resolve,reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve); });
    return `http://127.0.0.1:${server.address().port}`;
}
async function safelyReject(promise, status, code) {
    await assert.rejects(promise, error => {
        assert.equal(error.status,status);
        assert.equal(error.statusCode,status);
        if (code) assert.equal(error.code,code);
        assert.ok(!JSON.stringify(error).includes('PRIVATE_SENTINEL'));
        assert.ok(!error.message.includes('PRIVATE_SENTINEL'));
        return true;
    });
}

async function main() {
    let client;
    assert.doesNotThrow(() => { client = require('../../modules/journeys/services/journeyAlgorithmClient'); },
        'the public algorithm protocol client must be available');
    delete process.env.JOURNEY_ALGORITHM_SERVICE_URL;
    delete process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN;
    delete process.env.JOURNEY_ALGORITHM_TIMEOUT_MS;
    assert.equal(client.configured(),false);
    assert.deepEqual(await client.capabilities(),unavailable);
    await safelyReject(client.compute('share',{facts:[]}),503,'unavailable');

    upstream = http.createServer((req,res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            received.push({url:req.url, method:req.method, headers:req.headers, body:raw ? JSON.parse(raw) : null});
            upstreamHandler(req,res);
        });
    });
    const base = await listen(upstream);
    Object.assign(process.env,{JOURNEY_ALGORITHM_SERVICE_URL:base+'/',JOURNEY_ALGORITHM_SERVICE_TOKEN:'test-service-token'});
    assert.equal(client.configured(),true);
    assert.deepEqual(client.configuration(),{url:base,token:'test-service-token',timeoutMs:120000});
    process.env.JOURNEY_ALGORITHM_TIMEOUT_MS='750';
    assert.equal(client.configuration().timeoutMs,750);
    process.env.JOURNEY_ALGORITHM_TIMEOUT_MS='garbage';
    assert.equal(client.configuration().timeoutMs,120000);
    delete process.env.JOURNEY_ALGORITHM_TIMEOUT_MS;
    for (const invalid of ['file:///etc/passwd','ftp://localhost',base+'?key=secret',base+'#fragment',base+'/?',base.replace('http://','http://user:password@')]) {
        process.env.JOURNEY_ALGORITHM_SERVICE_URL=invalid;
        assert.equal(client.configured(),false,invalid);
        await safelyReject(client.compute('share',{}),503,'unavailable');
    }
    process.env.JOURNEY_ALGORITHM_SERVICE_URL=base;
    process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN='token\r\nInjected: value';
    assert.equal(client.configured(),false);
    process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN='test-service-token';

    const remoteCapabilities={text_ai:true,vision_ai:false,amap_search:true,amap_export:false,version:'private-v1'};
    upstreamHandler=(_req,res)=>json(res,200,{protocol_version:1,result:remoteCapabilities});
    assert.deepEqual(await client.capabilities(),remoteCapabilities);
    assert.equal(received.at(-1).url,'/v1/capabilities');
    assert.equal(received.at(-1).method,'GET');
    assert.equal(received.at(-1).headers.authorization,'Bearer test-service-token');
    upstreamHandler=(_req,res)=>json(res,200,{protocol_version:1,result:{...remoteCapabilities,text_ai:'true'}});
    assert.deepEqual(await client.capabilities(),unavailable,'malformed remote flags must not enable features');
    upstreamHandler=(_req,res)=>json(res,503,{protocol_version:1,error:{code:'unavailable',message:'PRIVATE_SENTINEL'}});
    assert.deepEqual(await client.capabilities(),unavailable,'remote outage must keep manual workflows available');

    for (const [operation,result] of Object.entries(results)) {
        upstreamHandler=(_req,res)=>json(res,200,{protocol_version:1,result});
        assert.deepEqual(await client.compute(operation,{facts:[]},{requestId:'request_1234567890123456'}),result);
        assert.equal(received.at(-1).url,`/v1/compute/${operation}`);
        assert.equal(received.at(-1).method,'POST');
        assert.deepEqual(received.at(-1).body,{request_id:'request_1234567890123456',input:{facts:[]}});
        assert.equal(received.at(-1).headers.authorization,'Bearer test-service-token');
        assert.equal(received.at(-1).headers['cache-control'],'no-store');
    }
    const unknownVisit={document:{...document,stops:[{...document.stops[0],visit_status:'unknown'}]}};
    upstreamHandler=(_req,res)=>json(res,200,{protocol_version:1,result:unknownVisit});
    assert.deepEqual(await client.compute('reconstruct',{}),unknownVisit,'unconfirmed experiences use the existing unknown status');
    upstreamHandler=(_req,res)=>json(res,200,{protocol_version:1,result:results.share});
    await client.compute('share',{});
    assert.match(received.at(-1).body.request_id,/^[A-Za-z0-9_-]{16,80}$/);
    const callCount=received.length;
    await safelyReject(client.compute('arbitrary-operation',{}),400,'invalid_input');
    await safelyReject(client.compute('share',{}, {requestId:'bad'}),400,'invalid_input');
    assert.equal(received.length,callCount,'invalid operations and IDs must not be sent upstream');

    for (const body of [{result:results.share},{protocol_version:2,result:results.share}, {protocol_version:1,result:results.share,private:'PRIVATE_SENTINEL'},
        {protocol_version:1,result:null}, {protocol_version:1,result:{text:17}}]) {
        upstreamHandler=(_req,res)=>json(res,200,body);
        await safelyReject(client.compute('share',{}),502,'invalid_response');
    }
    const malformed = {
        reconstruct:[{document:{...document,stops:'PRIVATE_SENTINEL'}},{document:{...document,stops:[null]}},{document:{...document,stops:[{...document.stops[0],lng:999}]}}],
        search:[{},[{...candidate,lng:'120'}],[{...candidate,source:'arbitrary'}]],
        rank:[{...rank,patches:null},{...rank,patches:[{...rank.patches[0],suggested_id:'unknown'}]}],
        merge:[{...merge,preview_hash:'invalid'},{...merge,sources:[]},{...merge,total_minor:'0'}],
        clarify:[{...clarify,answer:null},{...clarify,draft_revision:-1}]
    };
    for (const [operation,bodies] of Object.entries(malformed)) for (const result of bodies) {
        upstreamHandler=(_req,res)=>json(res,200,{protocol_version:1,result});
        await safelyReject(client.compute(operation,{}),502,'invalid_response');
    }

    for (const [status,code] of [[400,'invalid_input'],[409,'conflict'],[410,'gone'],[413,'payload_too_large'],[429,'rate_limited'],[503,'unavailable']]) {
        upstreamHandler=(_req,res)=>json(res,status,{protocol_version:1,error:{code,message:'PRIVATE_SENTINEL',retry_after:7,stack:'PRIVATE_SENTINEL',input:'PRIVATE_SENTINEL'}});
        await assert.rejects(client.compute('share',{}), error => {
            assert.equal(error.status,status);assert.equal(error.statusCode,status);assert.equal(error.code,code);
            assert.equal(error.retry_after,7);assert.equal(error.details?.retry_after,7);
            assert.ok(!JSON.stringify(error).includes('PRIVATE_SENTINEL'));assert.ok(!error.message.includes('PRIVATE_SENTINEL'));
            return true;
        });
    }
    upstreamHandler=(_req,res)=>json(res,409,{protocol_version:1,error:{code:'PRIVATE_SENTINEL',message:'PRIVATE_SENTINEL'}});
    await safelyReject(client.compute('share',{}),409,'conflict');
    upstreamHandler=(_req,res)=>json(res,500,{error:{message:'PRIVATE_SENTINEL',stack:'PRIVATE_SENTINEL'}});
    await safelyReject(client.compute('share',{}),502,'upstream_error');
    upstreamHandler=(_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('PRIVATE_SENTINEL');};
    await safelyReject(client.compute('share',{}),502,'invalid_response');
    upstreamHandler=(_req,res)=>json(res,200,{protocol_version:1,result:{text:'x'.repeat(1024*1024)}});
    await safelyReject(client.compute('share',{}),502,'invalid_response');
    upstreamHandler=(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write(' '.repeat(600000));res.end(' '.repeat(600000));};
    await safelyReject(client.compute('share',{}),502,'invalid_response');
    const redirectStart=received.length;
    upstreamHandler=(_req,res)=>{res.writeHead(302,{Location:base+'/credential-leak'});res.end();};
    await safelyReject(client.compute('share',{}),503,'unavailable');
    assert.equal(received.length,redirectStart+1,'redirects must never forward the bearer token');

    const beforeTimeout=received.length;
    upstreamHandler=(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write(' ');};
    const started=Date.now();
    await safelyReject(client.compute('share',{}, {timeoutMs:40}),503,'timeout');
    assert.ok(Date.now()-started<2000,'timeout must cover streaming response bodies');
    assert.equal(received.length,beforeTimeout+1,'generation requests must not automatically retry');
    const controller=new AbortController();
    const pending=client.compute('share',{}, {signal:controller.signal,timeoutMs:2000});
    setTimeout(()=>controller.abort(),30);
    await safelyReject(pending,503,'aborted');
    const preAborted=new AbortController();preAborted.abort();
    const beforePreAbort=received.length;
    await safelyReject(client.compute('share',{}, {signal:preAborted.signal}),503,'aborted');
    assert.equal(received.length,beforePreAbort,'already canceled work must not reach the service');

    const {db}=require('../../infrastructure/database');sql=db._raw;
    sql.exec('CREATE TABLE Place (id INTEGER PRIMARY KEY,name TEXT,longitude REAL,latitude REAL,address TEXT,private_note TEXT)');
    const insert=sql.prepare('INSERT INTO Place(name,longitude,latitude,address,private_note) VALUES(?,120,30,?,?)');
    insert.run('杭州面馆','地址','PRIVATE_SENTINEL');insert.run('另一家面馆','地址2','PRIVATE_SENTINEL');insert.run('西湖饭店','地址3','PRIVATE_SENTINEL');
    for(let i=0;i<402;i++)insert.run(`批量面馆${i}`,'批量地址','PRIVATE_SENTINEL');
    const app=express();app.use(express.json({limit:'2kb'}));
    app.use('/internal/journey-algorithms/places',require('../../modules/journeys/routes/algorithmPlaces'));
    callbackServer=http.createServer(app);
    const callbackBase=await listen(callbackServer);
    async function callback(body,token='callback-secret') {
        const response=await nativeFetch(callbackBase+'/internal/journey-algorithms/places',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
        assert.equal(response.headers.get('cache-control'),'no-store');
        return {status:response.status,body:await response.json()};
    }
    delete process.env.JOURNEY_ALGORITHM_CALLBACK_TOKEN;
    assert.equal((await callback({name:'面馆'})).status,503);
    process.env.JOURNEY_ALGORITHM_CALLBACK_TOKEN='callback-secret';
    for(const token of ['', 'wrong', 'callback-secret-extra'])assert.equal((await callback({name:'面馆'},token)).status,401);
    const places=await callback({name:'杭州面馆'});
    assert.equal(places.status,200);
    assert.deepEqual(places.body,{places:[{id:1,name:'杭州面馆',longitude:120,latitude:30,address:'地址'}]});
    const sanitized=await callback({name:'  杭州%_面馆  '});
    assert.deepEqual(sanitized.body,places.body,'LIKE wildcards must be stripped as in the original search');
    const bounded=await callback({name:'批量面馆'});
    assert.equal(bounded.body.places.length,400);
    for(const body of [{name:''},{name:'   '},{name:'%_'},{name:'x'.repeat(101)},{name:12},{name:'面馆',sql:'SELECT * FROM User'},{name:'\u0000'}]) {
        assert.equal((await callback(body)).status,400,JSON.stringify(body));
    }
    assert.deepEqual((await callback({name:"' OR 1=1 --"})).body,{places:[]},'names must remain bound SQL parameters');
    console.log('Journey algorithm transport tests passed: real HTTP protocol, response validation, safe errors, cancellation, limits, callback authorization and place isolation.');
}

main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    global.fetch=nativeFetch;
    for(const server of [upstream,callbackServer])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(sql)sql.close();
    for(const [key,value] of Object.entries(savedEnvironment))if(value===undefined)delete process.env[key];else process.env[key]=value;
    const absolute=path.resolve(temporary),root=path.resolve(os.tmpdir())+path.sep;
    if(absolute.startsWith(root)&&path.basename(absolute).startsWith('yuyuko-algorithm-client-'))fs.rmSync(absolute,{recursive:true,force:true});
});
