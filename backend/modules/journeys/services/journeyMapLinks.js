const {sql,now,string}=require('./journeyStore');
const {defaultCreationScore,insertCreationRating}=require('../../ratings/services/placeRatings');
const {registerNewPlaceSync}=require('../../places/services/placeModeration');

// Decides, per diary stop, whether saving links an existing marker, creates a missing one, or neither.
// Only confirmed, visited, located stops reach the map; a search center or a guess never becomes a marker.
const PLACEHOLDER_NAMES=new Set(['待选店','待确认地点','新地点','未命名地点']);
const normalizeName=name=>String(name||'').toLowerCase().replace(/[\s（）()·\-—_,，。.、]/g,'');
const located=s=>Number.isFinite(s.lng)&&Number.isFinite(s.lat)&&Math.abs(s.lng)<=180&&Math.abs(s.lat)<=90;
function meters(a,b) {
    const rad=x=>x*Math.PI/180,dlat=rad(b.lat-a.lat),dlng=rad(b.lng-a.lng);
    return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlng/2)**2)));
}
function similarName(a,b) {
    const x=normalizeName(a),y=normalizeName(b);
    return !!x&&!!y&&(x===y||(Math.min(x.length,y.length)>=2&&(x.includes(y)||y.includes(x))));
}
// A same or similar name nearby is a possible duplicate for the author to decide; it is never merged automatically.
// Only public markers count: a place still under moderation is not shown to other users (also used by the QQ bot).
function findDuplicates(stop,radius=500) {
    const dLat=radius/111000,dLng=radius/(111000*Math.max(0.2,Math.cos(stop.lat*Math.PI/180)));
    return sql.prepare("SELECT id,name,longitude,latitude,address FROM Place WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND moderation_status='visible' LIMIT 400")
        .all(stop.lat-dLat,stop.lat+dLat,stop.lng-dLng,stop.lng+dLng)
        .filter(p=>similarName(p.name,stop.name))
        .map(p=>({id:p.id,name:p.name,address:p.address||'',lng:p.longitude,lat:p.latitude,distance_m:Math.round(meters(stop,{lng:p.longitude,lat:p.latitude}))}))
        .filter(p=>p.distance_m<=radius).sort((a,b)=>a.distance_m-b.distance_m).slice(0,5);
}
function externalKey(stop) {
    return stop.source==='amap'&&/^amap_[A-Za-z0-9_-]{1,100}$/.test(stop.external_id||'')?stop.external_id.slice(5):'';
}
function mappedPlace(externalId) {
    return externalId?sql.prepare('SELECT place_id FROM PlaceExternalIdentity WHERE provider=? AND external_id=?').get('amap',externalId)?.place_id||null:null;
}
// A stop is public unless the author hid it (older drafts) or it was only mentioned/planned.
function stopIsPublic(stop) {return typeof stop.public==='boolean'?stop.public:stop.visit_status!=='planned';}
function mapReason(stop) {
    if(stop.map_link===false)return {reason:'unlinked',message:'已取消地图关联'};
    if(stop.visit_status==='planned')return {reason:'not_visited',message:'只是提到或计划，不加入地图'};
    if(stop.visit_status!=='visited')return {reason:'unknown_visit',message:'未确认到访，不加入地图'};
    if(!stop.confirmed)return {reason:'unconfirmed',message:'尚未核对，不加入地图'};
    if(!located(stop))return {reason:'unlocated',message:'待定位，暂不加入地图'};
    return null;
}
function planStop(stop,visibility) {
    const blocked=mapReason(stop);
    if(blocked)return {action:'none',...blocked};
    if(stop.place_id&&sql.prepare('SELECT id FROM Place WHERE id=?').get(stop.place_id))return {action:'link',place_id:stop.place_id};
    // A stop bound to a marker that was later deleted keeps its snapshot; the marker is not recreated.
    if(stop.source==='local')return {action:'none',reason:'place_removed',message:'原地图标记已删除，仅保留日记中的地点'};
    const external=externalKey(stop),mapped=mappedPlace(external);
    if(mapped)return {action:'link',place_id:mapped,external_id:external};
    if(visibility!=='public')return {action:'none',reason:'private',message:'私密日记不创建公共标记，地点保留在日记中'};
    // The hidden-stop rule covers the map as well as the text: a stop left out of the public body never creates a public marker.
    if(!stopIsPublic(stop))return {action:'none',reason:'hidden',message:'这一站不公开，不创建公共标记'};
    if(PLACEHOLDER_NAMES.has(String(stop.name||'').trim())||!normalizeName(stop.name))return {action:'none',reason:'unnamed',message:'请先填写店名，再创建标记'};
    const acknowledged=new Set(stop.duplicate_ack||[]);
    const duplicates=findDuplicates(stop);
    const unresolved=duplicates.filter(d=>!acknowledged.has(d.id));
    if(unresolved.length)return {action:'conflict',reason:'duplicate',message:'附近已有名称相似的标记，请确认是否为同一家',duplicates:unresolved,external_id:external};
    return {action:'create',external_id:external};
}
// Stops of one save that point at the same new shop create a single marker.
function creationKey(stop,link) {
    return link.external_id?`amap:${link.external_id}`:`manual:${normalizeName(stop.name)}:${stop.lng.toFixed(4)}:${stop.lat.toFixed(4)}`;
}
function planLinks(document,visibility) {
    const links=document.stops.map(stop=>({stop_id:stop.id,name:stop.name,...planStop(stop,visibility)}));
    const keys=new Map();
    links.forEach((link,i)=>{
        if(link.action!=='create')return;
        const key=creationKey(document.stops[i],link);
        link.creation_key=key;
        if(keys.has(key))link.same_as=keys.get(key);else keys.set(key,link.stop_id);
    });
    return links;
}
// Runs inside the commit transaction. The external identity unique key makes concurrent saves reuse one marker.
function createPlace(userId,stop,link) {
    const external=link.external_id||'';
    const existing=mappedPlace(external);
    if(existing)return {place_id:existing,created:false};
    const name=string(stop.name,120).replace(/<[^>]*>/g,'');
    const category=string(stop.category,16).replace(/[<>,，]/g,'');
    const id=Number(sql.prepare(`INSERT INTO Place(name,description,latitude,longitude,category,creator_id,updated_time,updated_by,address)
        VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?)`).run(name,'',stop.lat,stop.lng,category,userId,userId,string(stop.address,250)||null).lastInsertRowid);
    // The diary holds the description, so the moderation check skips the brief-description rule for these markers.
    registerNewPlaceSync(id,userId,'diary');
    if(category)sql.prepare('INSERT OR IGNORE INTO Category(name,is_common,sort_order,created_by) VALUES(?,0,1000,?)').run(category,userId);
    // Same creator rating as other creation paths; a duplicate below deletes the place and cascades it away.
    insertCreationRating(id,userId,defaultCreationScore(category),Date.now(),'creation_default');
    require('../../places/services/placeRevisions').recordPlaceRevision({placeId:id,authorId:userId,path:'diary'});
    if(external){
        const inserted=sql.prepare('INSERT OR IGNORE INTO PlaceExternalIdentity(provider,external_id,place_id,created_at) VALUES(?,?,?,?)').run('amap',external,id,now());
        if(!inserted.changes){
            sql.prepare('DELETE FROM Place WHERE id=?').run(id);
            return {place_id:mappedPlace(external),created:false};
        }
    }
    return {place_id:id,created:true};
}
module.exports={normalizeName,similarName,findDuplicates,planLinks,createPlace,located,mapReason,stopIsPublic};
