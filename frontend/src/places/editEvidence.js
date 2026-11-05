import { t } from '../i18n/index.js';
const text=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const labels={name:()=>t('map:editEvidence.field.name'),description:()=>t('map:editEvidence.field.description'),category:()=>t('map:editEvidence.field.category'),per_person_cost:()=>t('map:editEvidence.field.per_person_cost'),latitude:()=>t('map:editEvidence.field.latitude'),longitude:()=>t('map:editEvidence.field.longitude'),exterior_images:()=>t('map:editEvidence.field.exterior_images'),menu_images:()=>t('map:editEvidence.field.menu_images')};
function images(value){if(Array.isArray(value))return value;try{return JSON.parse(value||'[]');}catch{return [];}}
export function editCommentPreview(before={},after={}){
    const lines=[];
    for(const field of ['name','description','category','per_person_cost','latitude','longitude','exterior_images','menu_images']){
        if(after[field]===undefined)continue;
        const image=field.endsWith('_images'),a=image?images(before[field]):before[field]??null,b=image?images(after[field]):after[field]??null;
        if(JSON.stringify(a)===JSON.stringify(b))continue;
        const show=v=>image?t('map:editEvidence.imagesUpdated'):text(v)||t('map:editEvidence.empty');
        lines.push(t('map:editEvidence.change',{field:labels[field](),before:show(a),after:show(b)}));
    }
    return lines.join('\n');
}
