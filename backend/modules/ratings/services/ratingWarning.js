// Explicit community warnings are independent of model-generated categories.
function hasAvoidTag(category){
    return (Array.isArray(category)?category:[category]).some(value=>String(value||'').split(/[,，/、|]/).some(tag=>tag.trim()==='避雷'));
}
// “待探索”：还没去过、先标记的地点。创建时不写创建者评价；没人评价前地图上显示问号图标（与网页 places/rating.js 一致）
const EXPLORE_TAG='待探索';
function hasExploreTag(category){
    return (Array.isArray(category)?category:[category]).some(value=>String(value||'').split(/[,，/、|]/).some(tag=>tag.trim()===EXPLORE_TAG));
}
module.exports={hasAvoidTag,hasExploreTag,EXPLORE_TAG};
