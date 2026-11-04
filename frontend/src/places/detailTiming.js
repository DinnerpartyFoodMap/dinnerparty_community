export function createDetailTiming(now=()=>performance.now()){
 let started=null,total=0;
 return {
  resume(){if(started===null)started=now();},
  flush(){if(started!==null){total+=Math.max(0,now()-started);started=null;}if(total<5000)return 0;const value=Math.min(300000,Math.floor(total));total=0;return value;}
 };
}
