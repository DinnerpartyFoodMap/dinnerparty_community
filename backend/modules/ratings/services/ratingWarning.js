// Explicit community warnings are independent of model-generated categories.
function hasAvoidTag(category){
    return (Array.isArray(category)?category:[category]).some(value=>String(value||'').split(/[,，/、|]/).some(tag=>tag.trim()==='避雷'));
}
module.exports={hasAvoidTag};
