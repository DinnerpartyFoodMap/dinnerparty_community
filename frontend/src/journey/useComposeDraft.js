import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {eventId,request} from './feedback';
import {prepareImageForUpload,UPLOAD_LIMITS} from '../platform/mediaPicker';
import {saveLocalCompose,loadLocalCompose,deleteLocalCompose,requestPersistentStorage} from '../platform/localDraftStore';
import {getTokenUserId} from '../platform/credentialStore';
import {today} from './shared';
import { t } from '../i18n/index.js';

// 图文生成的素材草稿：先约 250ms 存到本机（含未上传的图片），停顿约 900ms 后按版本号同步到服务器。
// 服务器只保存已上传成功的图片引用；冲突、离线、本机未落盘都如实显示，不静默覆盖。
export const MAX_PHOTOS=12;
const emptyPayload=preset=>({text:preset?.text||'',start_date:preset?.date||today(),end_date:preset?.date||today(),
    center:preset?.center||null,media_notes:{},intended_visibility:'public'});
const contentOf=(payload,photos)=>({...payload,media_ids:photos.filter(p=>p.mediaId).map(p=>p.mediaId),
    media_notes:Object.fromEntries(photos.filter(p=>p.mediaId&&p.kind).map(p=>[p.mediaId,{kind:p.kind}]))});
const hasContent=(payload,photos)=>!!payload.text.trim()||photos.length>0;
const photoFromServer=(mediaId,notes)=>({key:mediaId,mediaId,status:'uploaded',kind:notes?.[mediaId]?.kind||'',file:null,url:''});

export default function useComposeDraft({base,token,composeId,preset}) {
    const userId=getTokenUserId(token);
    const [id,setId]=useState(()=>composeId||eventId());
    const [payload,setPayloadState]=useState(()=>emptyPayload(preset));
    const [photos,setPhotos]=useState([]);
    const [loaded,setLoaded]=useState(!composeId);
    const [sync,setSync]=useState({kind:'empty',message:''});
    const [local,setLocal]=useState({saved:false,blobs:true});
    const [job,setJob]=useState(null),[structured,setStructured]=useState(null),[closed,setClosed]=useState('');
    const revision=useRef(0),syncedHash=useRef(null),inFlight=useRef(null),paused=useRef(false),mounted=useRef(true);
    const latest=useRef({payload,photos,id});latest.current={payload,photos,id};
    const api=useCallback((path,options)=>request(base,token,`/api/journeys${path}`,options),[base,token]);
    useEffect(()=>{mounted.current=true;requestPersistentStorage();return()=>{mounted.current=false;};},[]);

    // 恢复：服务器版本与本机未同步记录取较新的一份；本机记录基于旧版本时，下一次同步会如实提示冲突。
    useEffect(()=>{
        if(!composeId)return;
        let active=true;
        (async()=>{
            const [server,record]=await Promise.all([api(`/compose-drafts/${composeId}`).catch(e=>e),loadLocalCompose(userId,composeId)]);
            if(!active)return;
            if(server instanceof Error&&server.status===410){deleteLocalCompose(userId,composeId);setClosed(server.message);setLoaded(true);return;}
            const useLocal=record&&!record.synced&&(server instanceof Error||record.updatedAt>Date.parse(server.updated_at));
            if(useLocal){
                revision.current=record.serverRevision||0;
                setPayloadState({...emptyPayload(),...record.payload});
                setPhotos(record.photos.map(p=>p.mediaId?{key:p.key,mediaId:p.mediaId,status:'uploaded',kind:p.kind||'',file:null,url:''}
                    :p.blob?{key:p.key,mediaId:null,status:'ready',kind:p.kind||'',file:p.blob,url:URL.createObjectURL(p.blob),name:p.name}
                    :{key:p.key,mediaId:null,status:'failed',kind:'',file:null,url:'',error:t('journey:composeDraft.photoNotSaved')}));
                setSync({kind:'local',message:t('journey:composeDraft.restoredLocal')});
            }else if(!(server instanceof Error)){
                revision.current=server.revision;
                const {media_ids,media_notes,...rest}=server.payload;
                setPayloadState({...emptyPayload(),...rest,media_notes:{}});
                setPhotos(media_ids.map(m=>photoFromServer(m,media_notes)));
                syncedHash.current=JSON.stringify(server.payload);
                setSync({kind:'synced',message:''});
            }else setSync({kind:'offline',message:server.message});
            if(!(server instanceof Error)){setJob(server.job);setStructured(server.structured_draft);}
            setLoaded(true);
        })();
        return()=>{active=false;};
    },[composeId,api,userId]);

    const setPayload=useCallback(patch=>setPayloadState(p=>({...p,...(typeof patch==='function'?patch(p):patch)})),[]);
    const content=useMemo(()=>contentOf(payload,photos),[payload,photos]);
    const pendingPhotos=photos.filter(p=>!p.mediaId).length;

    // 本机落盘：未上传的图片以 Blob 保存在 IndexedDB；不可用时说明哪些内容没有落盘。
    useEffect(()=>{
        if(!loaded||!userId||closed||!hasContent(payload,photos))return;
        const timer=setTimeout(async()=>{
            const result=await saveLocalCompose(userId,id,{payload:{...payload,media_notes:content.media_notes},
                photos:photos.map(p=>({key:p.key,mediaId:p.mediaId||null,kind:p.kind||'',name:p.name||'',blob:p.mediaId?null:p.file||null})),serverRevision:revision.current,synced:false});
            if(mounted.current){setLocal(result);setSync(s=>s.kind==='empty'?{kind:'local',message:''}:s);}
        },250);
        return()=>clearTimeout(timer);
    },[payload,photos,content,id,userId,loaded,closed]);

    // A write whose response was lost has an unknown outcome. It is replayed unchanged (same revision, same body)
    // before newer edits are sent; the server acknowledges an identical retry without treating it as a conflict.
    const pendingWrite=useRef(null);
    const push=useCallback(async()=>{
        const {payload:p,photos:list}=latest.current;
        if(!hasContent(p,list)||closed)return null;
        while(inFlight.current){try{await inFlight.current;}catch{}}
        let attempt=pendingWrite.current;
        if(!attempt){
            const body=contentOf(latest.current.payload,latest.current.photos),hash=JSON.stringify(body);
            if(hash===syncedHash.current)return {id:latest.current.id,revision:revision.current};
            attempt={draftId:latest.current.id,revision:revision.current,body,hash};
        }
        pendingWrite.current=attempt;
        setSync({kind:'saving',message:''});
        const operation=api(`/compose-drafts/${attempt.draftId}`,{method:'PUT',body:JSON.stringify({revision:attempt.revision,payload:attempt.body})});
        inFlight.current=operation;
        let saved;
        try{saved=await operation;}
        catch(e){
            const uncertain=!e.status||e.status>=500||e.status===429;
            if(!uncertain)pendingWrite.current=null;
            paused.current=e.status===409||e.status===410;
            if(mounted.current){
                if(e.status===410)setClosed(e.message);
                setSync({kind:e.status===409?'conflict':uncertain?'offline':'error',message:e.message});
            }
            throw e;
        }finally{if(inFlight.current===operation)inFlight.current=null;}
        revision.current=saved.revision;syncedHash.current=attempt.hash;pendingWrite.current=null;paused.current=false;
        if(mounted.current)setJob(saved.job);
        const now=latest.current;
        // Edits made while this write was uncertain or in flight are sent next, on top of the confirmed revision.
        if(JSON.stringify(contentOf(now.payload,now.photos))!==attempt.hash)return push();
        if(mounted.current)setSync({kind:'synced',message:''});
        // 服务器已有最新内容且没有待上传图片时，本机记录不再需要
        if(!now.photos.some(x=>!x.mediaId))deleteLocalCompose(userId,attempt.draftId);
        return {id:attempt.draftId,revision:saved.revision};
    },[api,userId,closed]);
    // 停顿约 900ms 后同步；离线时每 5 秒与恢复联网时重试
    useEffect(()=>{
        if(!loaded||paused.current||!hasContent(payload,photos))return;
        const timer=setTimeout(()=>push().catch(()=>{}),900);
        return()=>clearTimeout(timer);
    },[content,loaded,push,payload,photos]);
    useEffect(()=>{
        const retry=()=>{if(!paused.current&&mounted.current)push().catch(()=>{});};
        const timer=setInterval(()=>{if(['offline'].includes(sync.kind))retry();},5000);
        window.addEventListener('online',retry);
        return()=>{clearInterval(timer);window.removeEventListener('online',retry);};
    },[push,sync.kind]);

    // ---- 图片队列：准备（摆正方向、压缩）→ 上传；每张独立显示状态，单张失败不影响其他图片 ----
    const update=(key,patch)=>setPhotos(list=>list.map(p=>p.key===key?{...p,...patch}:p));
    const addFiles=useCallback(async files=>{
        const room=MAX_PHOTOS-latest.current.photos.length;
        const accepted=files.slice(0,Math.max(0,room));
        const entries=accepted.map(file=>({key:eventId(),mediaId:null,status:'preparing',kind:'',file,url:URL.createObjectURL(file),name:file.name}));
        setPhotos(list=>[...list,...entries]);
        for(const entry of entries){
            try{
                const prepared=await prepareImageForUpload(entry.file,UPLOAD_LIMITS.journeyMedia);
                update(entry.key,{file:prepared,status:'ready',error:''});
            }catch(e){update(entry.key,{status:'failed',error:e.message||t('journey:composeDraft.photoUnreadable')});}
        }
        return files.length-accepted.length;
    },[]);
    const uploading=useRef(false);
    useEffect(()=>{
        const next=photos.find(p=>p.status==='ready');
        if(!next||uploading.current||!token)return;
        uploading.current=true;update(next.key,{status:'uploading'});
        const form=new FormData();form.append('image',next.file,next.name||'photo.jpg');
        api('/media',{method:'POST',body:form})
            .then(media=>{if(mounted.current)update(next.key,{mediaId:media.id,status:'uploaded',error:''});})
            .catch(e=>{if(mounted.current)update(next.key,{status:'failed',error:e.message||t('common:error.uploadFailed')});})
            .finally(()=>{uploading.current=false;if(mounted.current)setPhotos(list=>[...list]);});
    },[photos,api,token]);
    const retryPhoto=useCallback(key=>setPhotos(list=>list.map(p=>p.key===key&&p.file?{...p,status:'ready',error:''}:p)),[]);
    // 移出只移除引用；图片仍在私人图片空间，不影响其他草稿或历史版本
    const removePhoto=useCallback(key=>setPhotos(list=>{const p=list.find(x=>x.key===key);if(p?.url)URL.revokeObjectURL(p.url);return list.filter(x=>x.key!==key);}),[]);
    const movePhoto=useCallback((from,to)=>setPhotos(list=>{
        if(to<0||to>=list.length||from===to)return list;
        const next=[...list];const [item]=next.splice(from,1);next.splice(to,0,item);return next;
    }),[]);
    const setPhotoKind=useCallback((key,kind)=>update(key,{kind}),[]);
    useEffect(()=>()=>latest.current.photos.forEach(p=>p.url&&URL.revokeObjectURL(p.url)),[]);

    // 离开前立即写入本机并返回结果（含未上传图片是否一起落盘），页面据此如实提示
    const saveLocalNow=useCallback(async()=>{
        const {payload:p,photos:list,id:draftId}=latest.current;
        if(!userId||closed||!hasContent(p,list))return {saved:false,blobs:false};
        const c=contentOf(p,list);
        const result=await saveLocalCompose(userId,draftId,{payload:{...p,media_notes:c.media_notes},
            photos:list.map(x=>({key:x.key,mediaId:x.mediaId||null,kind:x.kind||'',name:x.name||'',blob:x.mediaId?null:x.file||null})),serverRevision:revision.current,synced:false});
        if(mounted.current)setLocal(result);
        return result;
    },[userId,closed]);
    // 服务器上已是当前内容，且没有待上传的图片
    const isSynced=useCallback(()=>{
        const {payload:p,photos:list}=latest.current;
        return !pendingWrite.current&&!list.some(x=>!x.mediaId)&&JSON.stringify(contentOf(p,list))===syncedHash.current;
    },[]);
    const flush=useCallback(async()=>{
        const saved=await push();
        if(!saved)throw new Error(t('journey:composeDraft.nothingToSave'));
        return saved;
    },[push]);
    const fork=useCallback(()=>{
        // 另存：用新草稿保存当前内容，原草稿（另一窗口的版本）保持不变
        const next=eventId();revision.current=0;syncedHash.current=null;paused.current=false;pendingWrite.current=null;
        setId(next);latest.current={...latest.current,id:next};setSync({kind:'local',message:t('journey:composeDraft.forked')});
        return push();
    },[push]);
    const reload=useCallback(async()=>{
        const server=await api(`/compose-drafts/${latest.current.id}`);
        revision.current=server.revision;paused.current=false;pendingWrite.current=null;
        const {media_ids,media_notes,...rest}=server.payload;
        syncedHash.current=JSON.stringify(server.payload);
        setPayloadState({...emptyPayload(),...rest,media_notes:{}});setPhotos(media_ids.map(m=>photoFromServer(m,media_notes)));
        deleteLocalCompose(userId,latest.current.id);setSync({kind:'synced',message:''});
    },[api,userId]);
    const discard=useCallback(async()=>{
        const draftId=latest.current.id;
        if(revision.current)await api(`/compose-drafts/${draftId}`,{method:'DELETE',body:JSON.stringify({revision:revision.current})});
        await deleteLocalCompose(userId,draftId);paused.current=true;
    },[api,userId]);
    return {id,loaded,payload,setPayload,photos,content,pendingPhotos,addFiles,retryPhoto,removePhoto,movePhoto,setPhotoKind,
        sync,local,job,setJob,structured,closed,flush,fork,reload,discard,saveLocalNow,isSynced,revision:()=>revision.current,hasContent:hasContent(payload,photos)};
}
