import { createComputeRuntime } from './computeRuntime.js';
const runtime = createComputeRuntime();
self.onmessage = async ({data}) => {
    try {
        const result = await runtime.handle(data);
        self.postMessage({requestId:data.requestId,dataRevision:data.dataRevision,viewRevision:data.viewRevision,result});
    } catch (error) {
        self.postMessage({requestId:data.requestId,error:{code:error.code || 'COMPUTE_ERROR',message:error.message}});
    }
};
