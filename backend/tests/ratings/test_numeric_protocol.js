const assert=require('node:assert/strict'),http=require('node:http'),client=require('../../infrastructure/numericAlgorithmClient');
async function main(){
    let mode='ok';const token='numeric-protocol-fixture',oldUrl=process.env.NUMERIC_ALGORITHM_SERVICE_URL,oldToken=process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN;
    const server=http.createServer(async(req,res)=>{
        assert.equal(req.headers.authorization,`Bearer ${token}`);let raw='';for await(const chunk of req)raw+=chunk;
        const {input}=JSON.parse(raw),base=Object.fromEntries(['contract_version','dataset_id','snapshot_id','input_revision','as_of_ms'].map(k=>[k,input[k]]));
        let result={...base,summaries:[{place_id:1,count:0,average:null,tier:null,distribution:{1:0,2:0,3:0,4:0}}]};
        if(mode==='wrong_context')result.input_revision++;
        if(mode==='unknown_place')result.summaries[0].place_id=2;
        if(mode==='invalid_personal')result={...base,summary:result.summaries[0],personalized:{average:3,tier:99,matched_raters:1,rater_count:1}};
        if(mode==='zero_weight')result={...base,reputations:[{user_id:'u',weight:0,beta:0,gamma:1,contribution:0,evidence:0,agreement:0,rating_count:0}],rating_weights:[]};
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({protocol_version:1,result}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));Object.assign(process.env,{NUMERIC_ALGORITHM_SERVICE_URL:`http://127.0.0.1:${server.address().port}`,NUMERIC_ALGORITHM_SERVICE_TOKEN:token});
    try{
        const empty={input_revision:1,status:'empty',dimensions:1024,algorithm_version:2,model:'test',source_place_count:0,vector_place_count:0,total_weight:0,updated_at:1000,vector_b64:null};
        assert.throws(()=>client.validate('preference',{...empty,updated_at:Number.MAX_SAFE_INTEGER},{input_revision:1,as_of_ms:1000,model:'test'}),/服务/,'profile time must equal the request time');
        const summary={count:0,average:null,tier:null,distribution:{1:0,2:0,3:0,4:0}};
        assert.throws(()=>client.validate('ratingview',{summary,personalized:null,viewer_preference:{...empty,input_revision:999}},{viewer_input:{input_revision:1,as_of_ms:1000,model:'test'}}),/服务/,'nested profile revision must match its actual viewer input');
        assert.throws(()=>client.validate('ratingview',{summary,personalized:null,viewer_preference:empty},{}),/服务/,'an unsolicited viewer profile cannot be published');
        assert.throws(()=>client.validate('preference',{...empty,source_place_count:1},{input_revision:1,as_of_ms:1000,model:'test'}),/服务/,'empty profiles cannot retain source places');
        const input={dataset_id:'protocol',ratings:[],place_ids:[1]};assert.equal((await client.compute('ratingsummary',input)).summaries[0].count,0);
        for(const bad of ['wrong_context','unknown_place']){mode=bad;await assert.rejects(client.compute('ratingsummary',input),e=>e.code==='invalid_response');}
        mode='invalid_personal';await assert.rejects(client.compute('ratingview',{place_id:1}),e=>e.code==='invalid_response');
        mode='zero_weight';await assert.rejects(client.compute('ratingweights',{users:[{id:'u'}],ratings:[]}),e=>e.code==='invalid_response');
        console.log('Independent numeric protocol fixture: auth, context, result identities, personalized shape and positive weights passed.');
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(oldUrl===undefined)delete process.env.NUMERIC_ALGORITHM_SERVICE_URL;else process.env.NUMERIC_ALGORITHM_SERVICE_URL=oldUrl;if(oldToken===undefined)delete process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN;else process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN=oldToken;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
