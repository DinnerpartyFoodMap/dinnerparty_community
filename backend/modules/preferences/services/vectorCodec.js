const DIMENSIONS=1024;
// Shared numeric codec; weighting and user profile composition are private.
function decodeVector(blob){
    if(!Buffer.isBuffer(blob)||blob.length!==DIMENSIONS*4)return null;
    const values=Float32Array.from({length:DIMENSIONS},(_,i)=>blob.readFloatLE(i*4));let sq=0;
    for(const n of values){if(!Number.isFinite(n))return null;sq+=n*n;}
    const norm=Math.sqrt(sq);return Number.isFinite(norm)&&norm>1e-12?Float32Array.from(values,n=>n/norm):null;
}
module.exports={decodeVector};
