// 原文区间工具：半句已归属时剩余部分仍可归属；逗号连接的多店可逐段归属；相邻片段合并为连续原文。
import assert from 'node:assert/strict';
import {unassignedSegments,addSpan} from "../../../src/journey/textSpans.mjs";

const text='甲店牛肉面很好吃，乙店奶茶太甜。后来去了丙店。';
const first={start:0,end:text.indexOf('，')+1};first.text=text.slice(first.start,first.end);
let left=unassignedSegments(text,[{excerpts:[first]}]);
assert.deepEqual(left.map(s=>s.text),['乙店奶茶太甜。','后来去了丙店。'],'the rest of a half-assigned sentence stays assignable');
for(const s of left)assert.equal(text.slice(s.start,s.end),s.text);
assert.deepEqual(unassignedSegments(text,[]).map(s=>s.text),['甲店牛肉面很好吃，','乙店奶茶太甜。','后来去了丙店。']);
// A covered range inside a clause leaves both ends.
left=unassignedSegments('在甲店吃了牛肉面和凉拌菜还有饮料',[{excerpts:[{start:5,end:8,text:'牛肉面'}]}]);
assert.deepEqual(left.map(s=>s.text),['在甲店吃了','和凉拌菜还有饮料']);
// Adjacent clauses merge into one continuous quote instead of "……" fragments.
const second={start:first.end,end:text.indexOf('。')+1};second.text=text.slice(second.start,second.end);
const merged=addSpan([first],second,text);
assert.equal(merged.length,1);assert.equal(merged[0].text,'甲店牛肉面很好吃，乙店奶茶太甜。');
const apart=addSpan([first],{start:text.indexOf('后来'),end:text.length,text:'后来去了丙店。'},text);
assert.equal(apart.length,2,'non-adjacent quotes stay separate');
console.log('journey text span tests passed');
