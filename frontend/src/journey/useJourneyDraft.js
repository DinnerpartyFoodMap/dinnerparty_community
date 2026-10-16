import {useCallback,useEffect,useRef,useState} from 'react';
import {eventId,request} from './feedback';
import {saveLocalDraft,loadLocalDraft,deleteLocalDraft,requestPersistentStorage} from '../platform/localDraftStore';
import {getTokenUserId} from '../platform/credentialStore';
import { t } from '../i18n/index.js';

// 本地草稿槽位：当前编辑器只有一份进行中的编辑
const LOCAL_SLOT='active';

const signature=j=>JSON.stringify([j.id||null,j.revision||0,j.document]);
export default function useJourneyDraft(base,token,journal,dirty) {
    const latest=useRef({journal,dirty});latest.current={journal,dirty};
    const active=useRef(null),generation=useRef(0),inFlight=useRef(null),publishing=useRef(false),paused=useRef(false),mounted=useRef(true);
    const pendingPublish=useRef(null),pendingWrite=useRef(null);
    const [state,setState]=useState({kind:'idle',message:''});
    // 本机保存的未同步编辑（按账号隔离）。服务端 revision/冲突协议保持不变，本地记录只是断网、被系统终止时的保险。
    const userId=getTokenUserId(token);
    const [localDraft,setLocalDraft]=useState(null);
    const localWrite=useRef(null);
    const writeLocal=useCallback((snapshot)=>{
        if(!userId||!snapshot)return;
        const meta=active.current;
        // 已与服务器一致的内容无需本地保险（避免同步完成后被延迟写入重新标记为未同步）
        if(meta&&meta.hash&&meta.hash===signature(snapshot)&&!pendingWrite.current)return;
        localWrite.current=saveLocalDraft(userId,LOCAL_SLOT,{journal:snapshot,serverDraftId:meta?.id||null,serverRevision:meta?.revision||0,synced:false});
    },[userId]);
    const clearLocal=useCallback(()=>{if(userId){deleteLocalDraft(userId,LOCAL_SLOT);}setLocalDraft(null);},[userId]);
    const report=useCallback((kind,message)=>{if(mounted.current)setState({kind,message});},[]);
    const start=useCallback(draft=>{
        generation.current++;paused.current=false;pendingPublish.current=null;pendingWrite.current=null;
        active.current=draft?{id:draft.id,revision:draft.revision,hash:signature({id:draft.journey_id,revision:draft.base_revision,document:draft.document})}:null;
        report(draft?'saved':'idle',draft?t('journey:journeyDraft.synced'):'');
    },[report]);
    const isSynced=useCallback(()=>!pendingPublish.current&&!pendingWrite.current&&(!latest.current.dirty||!!(active.current&&latest.current.journal&&active.current.hash===signature(latest.current.journal))),[]);
    const persist=useCallback(async(snapshot=latest.current.journal,keepalive=false)=>{
        if(!snapshot||!token)return null;
        if(pendingPublish.current)throw new Error(t('journey:journeyDraft.pendingConfirm'));
        const epoch=generation.current;
        while(inFlight.current){try{await inFlight.current;}catch{}if(epoch!==generation.current)return null;}
        if(epoch!==generation.current)return null;
        if(pendingPublish.current)throw new Error(t('journey:journeyDraft.confirmPreviousFirst'));
        if(!active.current)active.current={id:eventId(),revision:0,hash:null};
        const meta=active.current,hash=signature(snapshot);
        if(meta.hash===hash&&!pendingWrite.current)return meta;
        const attempt=pendingWrite.current||{hash,body:{journey_id:snapshot.id||null,base_revision:snapshot.revision||0,draft_revision:meta.revision,document:snapshot.document,
            ...(snapshot.compose_draft_id&&!meta.revision?{compose_draft_id:snapshot.compose_draft_id,compose_revision:snapshot.compose_revision}:{})}};
        pendingWrite.current=attempt;
        report('saving',t('journey:journeyDraft.syncing'));
        const operation=request(base,token,`/api/journeys/drafts/${meta.id}`,{method:'PUT',keepalive,body:JSON.stringify(attempt.body)});
        inFlight.current=operation;
        try{
            const result=await operation;
            if(epoch!==generation.current)return null;
            meta.revision=result.revision;meta.hash=attempt.hash;pendingWrite.current=null;paused.current=false;
            report('saved',t('journey:journeyDraft.synced'));
            // 服务器已保存最新内容：本地保险记录可以移除；仍有新编辑时更新记录中的服务器版本号
            if(latest.current.journal&&signature(latest.current.journal)===meta.hash)clearLocal();
            else if(latest.current.dirty)writeLocal(latest.current.journal);
        }catch(e){
            if(epoch===generation.current){paused.current=!!e.status&&e.status!==429&&e.status<500;if(paused.current)pendingWrite.current=null;report(paused.current?'conflict':'offline',paused.current?e.message:t('journey:journeyDraft.retrying'));}
            throw e;
        }finally{if(inFlight.current===operation)inFlight.current=null;}
        // Resolve an uncertain earlier write before sending edits made since then.
        if(meta.hash!==hash)return persist(snapshot,keepalive);
        return meta;
    },[base,token,report,clearLocal,writeLocal]);
    const flush=useCallback(async()=>{
        // A change may arrive while the previous write is in flight.
        while(latest.current.dirty&&!isSynced()){
            const snapshot=latest.current.journal;
            if(!await persist(snapshot))throw new Error(t('journey:journeyDraft.stateChanged'));
        }
        return true;
    },[persist,isSynced]);
    const publish=useCallback(async(snapshot,asCopy=false)=>{
        publishing.current=true;
        try{
            if(!pendingPublish.current){
                const meta=await persist(snapshot);
                if(!meta)throw new Error(t('journey:journeyDraft.notSynced'));
                pendingPublish.current={id:meta.id,revision:meta.revision,snapshot,asCopy};
            }
            const attempt=pendingPublish.current;
            try{
                const saved=await request(base,token,`/api/journeys/drafts/${attempt.id}/publish`,{method:'POST',body:JSON.stringify({draft_revision:attempt.revision,as_copy:attempt.asCopy})});
                start(null);clearLocal();return {saved,snapshot:attempt.snapshot};
            }catch(e){
                if(e.status&&e.status<500)pendingPublish.current=null;
                else {paused.current=true;report('pending',t('journey:journeyDraft.pendingSaveDiary'));}
                throw e;
            }
        }finally{publishing.current=false;}
    },[base,token,persist,start,report,clearLocal]);
    /**
     * 带可见性的保存：先确认服务端针对这一草稿版本的预览与用户看到的一致，再用固定请求编号提交。
     * 响应丢失时重试同一请求（相同编号、相同内容），服务端返回原结果，不会重复建点或公开。
     */
    const commit=useCallback(async(snapshot,{visibility,previewHash,asCopy=false})=>{
        publishing.current=true;
        try{
            if(!pendingPublish.current){
                const meta=await persist(snapshot);
                if(!meta)throw new Error(t('journey:journeyDraft.notSynced'));
                const preview=await request(base,token,`/api/journeys/drafts/${meta.id}/map-preview`,{method:'POST',body:JSON.stringify({draft_revision:meta.revision,visibility,as_copy:asCopy})});
                // 公开保存必须与用户看到的预览一致；私密保存不公开任何内容，直接使用该版本的预览
                if(visibility==='public'&&preview.preview_hash!==previewHash)throw Object.assign(new Error(t('journey:journeyDraft.previewChanged')),{code:'preview_stale',preview});
                pendingPublish.current={id:meta.id,snapshot,commit:{draft_revision:meta.revision,visibility,preview_hash:preview.preview_hash,request_id:eventId(),as_copy:asCopy}};
            }
            const attempt=pendingPublish.current;
            if(!attempt.commit)throw new Error(t('journey:journeyDraft.confirmPreviousSave'));
            try{
                const result=await request(base,token,`/api/journeys/drafts/${attempt.id}/commit`,{method:'POST',body:JSON.stringify(attempt.commit)});
                start(null);clearLocal();return {result,snapshot:attempt.snapshot};
            }catch(e){
                if(e.status&&e.status<500)pendingPublish.current=null;
                else {paused.current=true;report('pending',t('journey:journeyDraft.pendingSave'));}
                throw e;
            }
        }finally{publishing.current=false;}
    },[base,token,persist,start,report,clearLocal]);
    // 编辑后及时本地落盘（不依赖网络，也不依赖退出时的最后一次请求）
    useEffect(()=>{
        if(!dirty||!journal||!userId)return;
        const timer=setTimeout(()=>writeLocal(journal),250);
        return()=>clearTimeout(timer);
    },[journal,dirty,userId,writeLocal]);
    // 读取本机未同步草稿，供编辑器提示恢复
    useEffect(()=>{
        if(!userId)return;
        let cancelled=false;
        requestPersistentStorage();
        loadLocalDraft(userId,LOCAL_SLOT).then(record=>{if(!cancelled&&record&&!record.synced&&record.journal)setLocalDraft(record);});
        return()=>{cancelled=true;};
    },[userId]);
    useEffect(()=>{
        if(!dirty||!journal)return;
        const timer=setTimeout(()=>{if(!publishing.current&&!paused.current)persist().catch(()=>{});},900);
        return()=>clearTimeout(timer);
    },[journal,dirty,persist]);
    useEffect(()=>{
        const retry=()=>{if(latest.current.dirty&&!publishing.current&&!paused.current&&!isSynced())persist().catch(()=>{});};
        const timer=setInterval(retry,5000);window.addEventListener('online',retry);
        const leave=e=>{if(!isSynced())e.detail.waitUntil(flush());};
        window.addEventListener('journey:before-leave',leave);
        const unload=e=>{if(!isSynced()){e.preventDefault();e.returnValue='';}};
        window.addEventListener('beforeunload',unload);
        const hide=()=>{
            if(isSynced())return;
            if(latest.current.dirty)writeLocal(latest.current.journal);
            if(!publishing.current&&!paused.current)persist(latest.current.journal,true).catch(()=>{});
        };
        window.addEventListener('pagehide',hide);
        const visibility=()=>{if(document.visibilityState==='hidden')hide();};
        document.addEventListener('visibilitychange',visibility);
        return()=>{clearInterval(timer);window.removeEventListener('online',retry);window.removeEventListener('journey:before-leave',leave);window.removeEventListener('beforeunload',unload);window.removeEventListener('pagehide',hide);document.removeEventListener('visibilitychange',visibility);};
    },[persist,flush,isSynced,writeLocal]);
    useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
    const fork=useCallback(()=>{start(null);return persist();},[start,persist]);
    /**
     * 恢复本机未同步草稿：沿用记录中的服务器草稿标识与版本，随后自动同步；
     * 若服务器上已有更新的版本，按现有冲突协议提示（不会静默覆盖）。
     * @returns {object|null} 需要载入编辑器的 journal
     */
    const restoreLocal=useCallback(()=>{
        const record=localDraft;
        if(!record)return null;
        generation.current++;paused.current=false;pendingPublish.current=null;pendingWrite.current=null;
        // hash 置空：恢复后的内容一定会重新同步到服务器
        active.current=record.serverDraftId?{id:record.serverDraftId,revision:record.serverRevision||0,hash:null}:null;
        report('offline',t('journey:journeyDraft.restoredSyncing'));
        setLocalDraft(null);
        return record.journal;
    },[localDraft,report]);
    const prepare=async()=>{await persist();await flush();return {id:active.current?.id,revision:active.current?.revision};};
    return {state,start,isSynced,flush,prepare,publish,commit,hasPendingSave:()=>!!pendingPublish.current,fork,currentId:()=>active.current?.id,currentRevision:()=>active.current?.revision,
        localDraft,restoreLocal,discardLocal:clearLocal};
}
