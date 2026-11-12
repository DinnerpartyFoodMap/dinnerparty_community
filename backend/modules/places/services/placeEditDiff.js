'use strict';
// What an edit records: only the text the editor added to the description.
// Old 123 → new 123456 records 456. It is both the edit comment (admin-only
// 修改记录) and the rating text evidence. Other field changes record nothing
// here; PlaceRevision keeps the full before/after state.
// frontend/src/places/editEvidence.js mirrors addedText for the edit preview;
// frontend test-edit-evidence compares the two.
const {cleanText}=require('../../ratings/services/ratingTextJudge');
const {markdownToPlainText}=require('./markdownText');
// A shared run shorter than this is a coincidental match inside rewritten text
// (one 的, a 。, the 茶 of 早茶 → 茶楼) when it sits between two added pieces or
// where old text around it was removed. It then counts as added, so the record
// reads as the new sentence instead of fragments.
const MIN_KEPT_RUN=4;
// A piece typed after existing text often starts with the punctuation that
// closed the previous sentence; it may end a sentence itself, so keep 。！？ at the end.
const EDGE_SEPARATORS=/^[\s，,、；;：:。．.！!？?…]+|[\s，,、；;：:]+$/gu;
// LCS alignment keeps every old character that is still in place; unmatched
// characters of the new text are the addition. Pieces separated by kept text
// are joined with " … ".
function addedText(before,after){
 const a=Array.from(cleanText(before)),b=Array.from(cleanText(after));if(a.join('')===b.join(''))return '';
 const width=b.length+1,dp=new Uint16Array((a.length+1)*width);
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i*width+j]=a[i]===b[j]?1+dp[(i+1)*width+j+1]:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
 const ops=[],push=(op,ch)=>{const last=ops[ops.length-1];if(last?.op===op)last.text+=ch;else ops.push({op,text:ch});};
 for(let i=0,j=0;i<a.length||j<b.length;){
  if(i<a.length&&j<b.length&&a[i]===b[j]){push('=',b[j]);i++;j++;}
  else if(i<a.length&&(j>=b.length||dp[(i+1)*width+j]>=dp[i*width+j+1]))push('-',a[i++]);
  else push('+',b[j++]);
 }
 const gap=(from,step)=>{const found={'+':false,'-':false};for(let k=from;k>=0&&k<ops.length&&ops[k].op!=='=';k+=step)found[ops[k].op]=true;return found;};
 const parts=[];let part='';
 ops.forEach((o,k)=>{
  if(o.op==='-')return;
  if(o.op==='='){
   const left=gap(k-1,-1),right=gap(k+1,1);
   const coincidental=Array.from(o.text).length<MIN_KEPT_RUN&&(left['+']&&right['+']||(left['+']||right['+'])&&(left['-']||right['-']));
   if(!coincidental){if(part)parts.push(part);part='';return;}
  }
  part+=o.text;
 });
 if(part)parts.push(part);
 // A piece reads as its own text: drop the joining punctuation it was typed after.
 return parts.map(p=>p.replace(EDGE_SEPARATORS,'')).filter(p=>/[\p{L}\p{N}]/u.test(p)).join(' … ').slice(0,1000);
}
// Descriptions are Markdown; compare the text a reader sees, not the syntax.
const plain=value=>markdownToPlainText(typeof value==='string'?value:String(value??''));
function editCommentText(before,after){return addedText(plain(before?.description),plain(after?.description));}
module.exports={addedText,editCommentText,MIN_KEPT_RUN};
