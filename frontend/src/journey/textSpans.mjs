// 原文区间工具（纯函数，前端与测试共用）。区间 {start,end,text} 都以原始描述的下标为准。

const CLAUSE=/[^。！？!?；;\n，,、]+[。！？!?；;，,、]?/g;
const PUNCT=/^[\s。！？!?；;，,、…\-—]*$/;

/**
 * 原文中尚未归属到任何站点的片段（“待归属”）。按分句计算剩余的未覆盖部分：
 * 同一句只归属了前半句时，后半句仍然列出；一行写了多家店（逗号连接）时可以逐段归属。
 */
export function unassignedSegments(text,stops,minChars=4) {
    if(!text)return [];
    const covered=stops.flatMap(s=>s.excerpts||[]).map(e=>[e.start,e.end]).sort((a,b)=>a[0]-b[0]);
    const result=[];
    for(const match of text.matchAll(CLAUSE)){
        let pieces=[[match.index,match.index+match[0].length]];
        for(const [cs,ce] of covered)pieces=pieces.flatMap(([s,e])=>ce<=s||cs>=e?[[s,e]]:[[s,Math.max(s,cs)],[Math.min(e,ce),e]].filter(([a,b])=>b>a));
        for(const [s,e] of pieces){
            const raw=text.slice(s,e),lead=raw.length-raw.trimStart().length,body=raw.trim();
            if(Array.from(body.replace(/[。！？!?；;，,、]/g,'')).length<minChars)continue;
            result.push({start:s+lead,end:s+lead+body.length,text:body});
        }
    }
    return result;
}

/** 加入一段摘录；与已有摘录之间只隔标点或空白时合并为一段连续原文，避免把整句拆成“……”分隔的碎片。 */
export function addSpan(excerpts,span,text) {
    const list=[...(excerpts||[]),span].sort((a,b)=>a.start-b.start);
    const merged=[];
    for(const item of list){
        const last=merged[merged.length-1];
        if(last&&text&&item.start>=last.end&&PUNCT.test(text.slice(last.end,item.start))){
            last.end=Math.max(last.end,item.end);last.text=text.slice(last.start,last.end);
        }else if(last&&item.start<last.end){
            last.end=Math.max(last.end,item.end);last.text=text?text.slice(last.start,last.end):last.text;
        }else merged.push({...item});
    }
    return merged;
}
