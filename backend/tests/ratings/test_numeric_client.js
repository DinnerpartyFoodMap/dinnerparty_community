const assert=require('node:assert/strict');
async function main(){
    let client;assert.doesNotThrow(()=>{client=require('../../infrastructure/numericAlgorithmClient');});
    const oldUrl=process.env.JOURNEY_ALGORITHM_SERVICE_URL,oldToken=process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN;
    const numericUrl=process.env.NUMERIC_ALGORITHM_SERVICE_URL,numericToken=process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN;
    delete process.env.NUMERIC_ALGORITHM_SERVICE_URL;delete process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN;
    delete process.env.JOURNEY_ALGORITHM_SERVICE_URL;delete process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN;
    try{await assert.rejects(client.compute('ratingsummary',{ratings:[],place_ids:[1]}),e=>e.status===503);}finally{
        if(numericUrl!==undefined)process.env.NUMERIC_ALGORITHM_SERVICE_URL=numericUrl;
        if(numericToken!==undefined)process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN=numericToken;
        if(oldUrl===undefined)delete process.env.JOURNEY_ALGORITHM_SERVICE_URL;else process.env.JOURNEY_ALGORITHM_SERVICE_URL=oldUrl;
        if(oldToken===undefined)delete process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN;else process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN=oldToken;
    }
    assert.throws(()=>client.validate('preference',{status:'ready',vector_b64:'garbage',dimensions:1024}),e=>e.code==='invalid_response');
    console.log('Numeric client configuration and result rejection passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
