import {eventId} from './feedback';
import {today} from './shared';
import {unassignedSegments,addSpan} from './textSpans.mjs';
import { t } from '../i18n/index.js';

export const newStop=(patch={})=>({id:eventId(),name:'待选店',note:'',lng:null,lat:null,place_id:null,address:'',source:'manual',confirmed:false,
    visit_status:'visited',at:'',mood:'',media_ids:[],expenses:[],excerpts:[],excerpt_edited:'',...patch});
export const newDocument=(date=today())=>({title:t('journey:reviewUtils.defaultTitle'),start_date:date,end_date:date,summary:'',stops:[],entry_media_ids:[],media_meta:{},intended_visibility:'public'});
export const located=s=>Number.isFinite(s?.lng)&&Number.isFinite(s?.lat);
/** 需要处理的站点：未核对，也没有选择“稍后补充”。 */
export const needsReview=s=>!s.confirmed&&s.location_resolution!=='deferred';
export function issueOf(stop) {
    if(!needsReview(stop))return null;
    if(stop.name==='待选店'||!located(stop))return stop.candidates?.length?t('journey:common.action.chooseShop'):t('journey:reviewUtils.issue.confirmLocation');
    return t('journey:reviewUtils.issue.checkPlace');
}
// 公开展示的文字：作者编辑优先；否则为原文摘录（多段之间用省略号分隔，不伪装成连续引用）。
export function excerptText(stop) {
    if(stop.excerpt_edited)return stop.excerpt_edited;
    return (stop.excerpts||[]).map(e=>e.text).join(t('journey:reviewUtils.excerptSeparator'));
}
/** 原文中尚未归属到任何站点的片段（“待归属”），见 textSpans.mjs。 */
export function unassignedSentences(text,stops) {return unassignedSegments(text,stops);}
/** 把一段原文加入某站的摘录；相邻片段合并为连续原文。 */
export function addExcerpt(stop,span,text) {return {excerpts:addSpan(stop.excerpts,span,text)};}
/** 地图上选中的地点（站内标记或高德搜索结果）转换为站点字段；用户亲自选定即视为已核对。 */
export function placeToStop(p,{amapAllowed}) {
    const external=p.isMarked===false||String(p.id).startsWith('amap_');
    if(external&&!amapAllowed)throw new Error(t('journey:reviewUtils.amapNotAllowed'));
    return {name:p.name,place_id:external?null:Number(p.id),lng:Number(p.longitude),lat:Number(p.latitude),address:p.address||'',source:external?'amap':'local',
        external_id:external?(String(p.id).startsWith('amap_')?String(p.id):`amap_${p.id}`):'',...CHOSEN};
}
/** 图钉选点：先保存坐标，地址读取后再补上。 */
export function pointToStop(point) {
    return {lng:point.lng,lat:point.lat,address:'',source:'manual',place_id:null,external_id:'',...CHOSEN};
}
const CHOSEN={visit_status:'visited',confirmed:true,location_resolution:'pending',candidates:[],needs_choice:false,suggested_id:null};
export function distanceMeters(a,b) {
    if(!located(a)||!located(b))return null;
    const rad=x=>x*Math.PI/180,dlat=rad(b.lat-a.lat),dlng=rad(b.lng-a.lng);
    return Math.round(12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlng/2)**2))));
}
export const formatDistance=m=>m==null?'':m<1000?t('journey:reviewUtils.meters', { m }):t('journey:reviewUtils.kilometers', { m: (m/1000).toFixed(m<10000?1:0) });
