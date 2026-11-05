'use strict';
const {cleanText}=require('../../ratings/services/ratingTextJudge');
const LABELS={name:'店名',description:'描述',category:'分类',per_person_cost:'人均',address:'地址',latitude:'纬度',longitude:'经度',exterior_images:'门面图片',menu_images:'菜单图片'};
// LCS retains every existing character; only unmatched additions are evidence.
function addedText(before,after){
 const a=Array.from(cleanText(before)),b=Array.from(cleanText(after));if(!a.length)return b.join('');if(a.join('')===b.join(''))return '';
 const width=b.length+1,dp=new Uint16Array((a.length+1)*width);
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i*width+j]=a[i]===b[j]?1+dp[(i+1)*width+j+1]:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
 let i=0,j=0,parts=[],part='';while(j<b.length){if(i<a.length&&a[i]===b[j]){if(part){parts.push(part);part='';}i++;j++;}else if(i<a.length&&dp[(i+1)*width+j]>=dp[i*width+j+1])i++;else part+=b[j++];}if(part)parts.push(part);
 return parts.filter(p=>/[\p{L}\p{N}]/u.test(p)).join(' … ').slice(0,1000);
}
function editDiff(before,after){
 const changes=[];for(const [key,label]of Object.entries(LABELS)){const a=before?.[key]??null,b=after?.[key]??null;if(JSON.stringify(a)===JSON.stringify(b))continue;
  const image=key.endsWith('_images');const value=v=>image?'已更新':cleanText(v)||'（空）';changes.push({field:key,before:a,after:b,line:`${label}：${value(a)} → ${value(b)}`});}
 return {changes,comment:changes.map(c=>c.line).join('\n'),text:changes.some(c=>c.field==='description')?addedText(before?.description,after?.description):''};
}
module.exports={addedText,editDiff};
