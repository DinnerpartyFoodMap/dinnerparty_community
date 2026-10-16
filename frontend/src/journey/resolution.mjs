// Keep this projection in sync with backend/services/journeyResolution.js.
// Notes, photos, money and time never belong to a location patch's write set.
import { t } from '../i18n/index.js';
export function locationBasis(document) {
    return JSON.stringify(document.stops.map(s=>[s.id,s.name,s.lng??null,s.lat??null,!!s.confirmed,s.visit_status,s.location_resolution||'pending',
        (s.candidates||[]).map(c=>[c.id,c.name,c.lng??null,c.lat??null,c.source,c.place_id??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]));
}
export function applyResolutionPatch(document,result) {
    if(locationBasis(document)!==result.basis)throw new Error(t('journey:resolution.stale'));
    const patches=new Map(result.patches.map(p=>[p.stop_id,p]));
    return {...document,stops:document.stops.map(s=>{
        const patch=patches.get(s.id);
        return !patch||s.confirmed||s.location_resolution==='deferred'||s.visit_status==='planned'?s:{...s,candidates:patch.candidates,suggested_id:patch.suggested_id,...(patch.candidate_basis?{candidate_basis:patch.candidate_basis}:{})};
    })};
}
