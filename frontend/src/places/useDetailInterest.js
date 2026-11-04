import {useEffect} from 'react';
import {recordPlaceBehavior} from './placeBehavior';
import {isAppActive,onAppStateChange} from '../platform/lifecycle';
import {createDetailTiming} from './detailTiming';

// Shared web/iOS foreground timing. Passive opens are weak interest, never an
// observed choice or proof of a visit. Hidden/background time is excluded.
export default function useDetailInterest({place,backendUrl,token,enabled}){
 const placeId=place?.isMarked===false?null:place?.id;
 useEffect(()=>{
  if(!enabled||!token||!placeId)return;
  let opened=false;const timing=createDetailTiming();if(isAppActive())timing.resume();
  const send=()=>{const duration=timing.flush();if(duration)void recordPlaceBehavior(backendUrl,token,placeId,'detail_dwell','place',{durationMs:duration,trigger:'unknown'});};
  const open=()=>{if(!opened&&isAppActive()){opened=true;void recordPlaceBehavior(backendUrl,token,placeId,'detail_open','place',{trigger:'unknown'});}};
  let timer=setTimeout(open,800);
  const unsubscribe=onAppStateChange(({active})=>{clearTimeout(timer);if(!active)send();else{timing.resume();timer=setTimeout(open,800);}});
  const hide=()=>send();window.addEventListener('pagehide',hide);
  return()=>{clearTimeout(timer);unsubscribe();window.removeEventListener('pagehide',hide);send();};
 },[placeId,backendUrl,token,enabled]);
}
