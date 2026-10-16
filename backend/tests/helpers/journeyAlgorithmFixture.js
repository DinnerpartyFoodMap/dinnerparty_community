const http=require('node:http');
const {createHash}=require('node:crypto');

// Public protocol integrity only: the caller has already supplied every merge decision.
function sealMergeSample(sample,resolutions={}) {
    const result=structuredClone(sample);
    result.preview_hash=createHash('sha256').update(JSON.stringify({document:result.document,sources:result.sources,
        policy:result.order_policy,resolutions:Object.entries(resolutions).sort(),conflicts:result.conflicts})).digest('hex');
    return result;
}

// Independent protocol double: callers supply finished results, never algorithms.
// Every test exercises the production HTTP client, including authentication and envelopes.
async function createJourneyAlgorithmFixture(options={}) {
    const token=options.token||'public-test-algorithm-token';
    const callbackToken=options.callbackToken||'public-test-callback-token';
    const capabilities={text_ai:false,vision_ai:false,amap_search:false,amap_export:false,version:'public-protocol-fixture',...options.capabilities};
    const handlers=new Map(Object.entries(options.handlers||{})),calls=[];
    const oldEnv=Object.fromEntries(['JOURNEY_ALGORITHM_SERVICE_URL','JOURNEY_ALGORITHM_SERVICE_TOKEN','JOURNEY_ALGORITHM_CALLBACK_TOKEN'].map(k=>[k,process.env[k]]));
    const server=http.createServer(async(req,res)=>{
        const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
        if(req.headers.authorization!==`Bearer ${token}`)return send(401,{error:'Unauthorized'});
        if(req.method==='GET'&&req.url==='/v1/capabilities')return send(200,{protocol_version:1,result:capabilities});
        const match=req.url.match(/^\/v1\/compute\/([a-z]+)$/);
        if(req.method!=='POST'||!match)return send(404,{error:'Not found'});
        try {
            let body='';for await(const chunk of req)body+=chunk;
            const payload=JSON.parse(body);
            if(!payload||typeof payload.request_id!=='string'||!payload.input||typeof payload.input!=='object')return send(400,{error:'Invalid request'});
            const operation=match[1],call={operation,input:payload.input,requestId:payload.request_id};calls.push(call);
            const handler=handlers.get(operation);
            if(!handler)return send(501,{error:`No canned result for ${operation}`});
            const result=await handler(payload.input,{requestId:payload.request_id,req,res,call});
            if(!res.writableEnded)send(200,{protocol_version:1,result});
        } catch(error) {
            if(!res.writableEnded)send(error.status||500,{error:'Fixture operation failed'});
        }
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const url=`http://127.0.0.1:${server.address().port}`;
    Object.assign(process.env,{JOURNEY_ALGORITHM_SERVICE_URL:url,JOURNEY_ALGORITHM_SERVICE_TOKEN:token,JOURNEY_ALGORITHM_CALLBACK_TOKEN:callbackToken});
    return {url,token,callbackToken,calls,server,
        setCapabilities(patch){Object.assign(capabilities,patch);},
        handle(operation,handler){handlers.set(operation,handler);},
        result(operation,value){handlers.set(operation,()=>structuredClone(value));},
        async close(){
            const closed=new Promise(resolve=>server.close(resolve));
            server.closeAllConnections();
            await closed;
            for(const [key,value] of Object.entries(oldEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
        }
    };
}
module.exports={createJourneyAlgorithmFixture,sealMergeSample};
