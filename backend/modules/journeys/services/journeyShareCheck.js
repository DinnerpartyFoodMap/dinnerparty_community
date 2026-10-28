// Checks a model-written share post against the facts the author chose to share.
// The prompt forbids invented prices, times and experiences, but nothing verified the output: a post may claim
// "花了 88 元、排队半小时、送了甜品" from a bare shop name. Concrete, high-impact claims (money, clock times,
// durations, queues, freebies) are listed when the facts do not back them, so the page can flag or remove them.
// It is a conservative text match, not proof that a backed claim is true.
const CLAIMS=[
    {kind:'price',pattern:/(?:[¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|块钱|块|rmb|RMB)|人均\s*\d+(?:\.\d+)?)/g},
    {kind:'time',pattern:/\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点(?:\s*(?:半|\d{1,2}\s*分?))?/g},
    {kind:'duration',pattern:/(?:\d+(?:\.\d+)?|[一二两三四五六七八九十几半]+)\s*个?\s*多?\s*(?:分钟|小时|钟头)|半个?小时/g},
    {kind:'queue',pattern:/排队|排了|等位|等了/g},
    {kind:'gift',pattern:/赠送|送了|免费送|白送|赠品/g}
];
const numbers=text=>(String(text).match(/\d+(?:\.\d+)?/g)||[]).map(Number);
const compact=text=>String(text).replace(/\s+/g,'');

function evidenceOf(facts) {
    const parts=[],values=new Set();
    for(const fact of facts){
        parts.push(fact.name||'',fact.note||'',fact.mood||'',fact.at||'');
        for(const e of fact.expenses||[]){parts.push(e.note||'');values.add(Number(e.amount));}
    }
    const text=compact(parts.join('\n'));
    numbers(text).forEach(n=>values.add(n));
    // A clock time in the stop time (2026-10-01T12:30) backs "12:30" and "12点半" alike.
    for(const fact of facts){
        const m=/T(\d{2}):(\d{2})$/.exec(fact.at||'');
        if(m){values.add(Number(m[1]));values.add(Number(m[2]));}
    }
    return {text,values};
}
function supported(claim,kind,evidence) {
    const digits=numbers(claim);
    if(kind==='price'||kind==='time')return digits.length>0&&digits.every(n=>evidence.values.has(n));
    if(digits.length)return digits.every(n=>evidence.values.has(n))&&evidence.text.includes(compact(claim).replace(/[\d.]+/g,'').slice(-2));
    return evidence.text.includes(compact(claim));
}
/** @returns {{kind:string,text:string}[]} at most 10 distinct unsupported claims, in reading order */
function unsupportedClaims(text,facts) {
    const evidence=evidenceOf(facts),found=[],seen=new Set();
    for(const {kind,pattern} of CLAIMS){
        for(const match of String(text||'').matchAll(pattern)){
            const claim=match[0].trim();
            if(!claim||seen.has(claim)||supported(claim,kind,evidence))continue;
            seen.add(claim);found.push({kind,text:claim,index:match.index});
        }
    }
    return found.sort((a,b)=>a.index-b.index).slice(0,10).map(({kind,text})=>({kind,text}));
}
module.exports={unsupportedClaims};
