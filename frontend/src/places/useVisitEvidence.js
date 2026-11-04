import {useEffect,useState,useRef} from 'react';
import {createVisitEvidence} from './visitEvidence';
import {getFreshLocation} from '../platform/geolocation';
import {isAppActive,onAppStateChange} from '../platform/lifecycle';

export default function useVisitEvidence({place,backendUrl,token,enabled,onVisited}){
 const [prompt,setPrompt]=useState(null);
 const [epoch,setEpoch]=useState(0);
 const placeId=place?.isMarked===false?null:place?.id;
 const identity=useRef(null);identity.current=`${token}|${placeId}|${enabled}`;
 useEffect(()=>{
  setPrompt(null);
  if(!enabled||!token||!placeId)return;
  const controller=new AbortController(),state=createVisitEvidence();let stopped=false,busy=false,view=null,started=0,timer=null;
  const request=async(kind,body)=>{
   const res=await fetch(`${backendUrl}/api/visits/places/${placeId}/${kind}`,{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body||{})});
   if(!res.ok)throw Error('visit unavailable');return res.json();
  };
  const sample=async()=>{
   if(Date.now()-started>900000&&started){clearInterval(timer);state.reset();return;}
   if(stopped||busy||!isAppActive()||!view)return;
   busy=true;
   try{
    const fix=await getFreshLocation({signal:controller.signal});
    if(stopped||!isAppActive())return;
    const proof=state.observe(place,fix);
    if(proof){const result=await request('evidence',{...proof,view_id:view.id});if(!stopped&&result.prompt)setPrompt({id:result.id,placeId,token});stopped=true;clearInterval(timer);}
   }catch{state.reset();}finally{busy=false;}
  };
  // Only an actually visible foreground detail creates a viewed candidate.
  const viewedTimer=setTimeout(async()=>{if(!isAppActive()||stopped)return;try{view=await request('view');started=Date.now();await sample();if(!stopped)timer=setInterval(sample,60000);}catch{}},800);
  const unsubscribe=onAppStateChange(({active})=>{state.reset();if(!active){stopped=true;controller.abort();clearInterval(timer);clearTimeout(viewedTimer);}else setEpoch(n=>n+1);});
  return()=>{stopped=true;controller.abort();clearTimeout(viewedTimer);clearInterval(timer);unsubscribe();};
 },[placeId,backendUrl,token,enabled,place?.latitude,place?.longitude,epoch]);
 const answer=async value=>{
  if(!prompt||prompt.placeId!==placeId||prompt.token!==token)return;
  const requestIdentity=identity.current;
  try{
   const res=await fetch(`${backendUrl}/api/visits/places/${placeId}/answer`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id:prompt.id,answer:value})});
   if(!res.ok||identity.current!==requestIdentity||!isAppActive())return;setPrompt(null);if(value==='yes')onVisited?.();
  }catch{/* Keep the invitation available for retry; failed requests are not answers. */}
 };
 return {prompt:prompt?.placeId===placeId&&prompt?.token===token?prompt:null,answer};
}
