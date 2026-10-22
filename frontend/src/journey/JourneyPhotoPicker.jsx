import React,{useRef,useState} from 'react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import {requestActionSheet,hasActionSheetHost} from '../components/overlay/ActionSheet';
import {pickImages,MediaError} from '../platform/mediaPicker';
import {PrivatePhoto} from './shared';
import {MAX_PHOTOS} from './useComposeDraft';
import { t, tx } from '../i18n/index.js';

const STATUS={preparing:t('journey:photoPicker.status.preparing'),ready:t('journey:photoPicker.status.ready'),uploading:t('journey:photoPicker.status.uploading'),uploaded:'',failed:t('journey:photoPicker.status.failed')};
export const KIND_LABEL={dish:t('journey:photoPicker.kind.dish'),menu:t('common:label.menu'),other:t('journey:photoPicker.kind.other')};

/**
 * 图片队列：相册多选 / 拍照，预览、移除、长按拖动或前移后移排序，单张重试。
 * 照片以美食为主；菜单只是可选标注，不要求逐张标注。
 */
export default function JourneyPhotoPicker({draft,base,token,onError}) {
    const {photos}=draft;
    const [previewKey,setPreviewKey]=useState(null);
    const [drag,setDrag]=useState(null);
    const items=useRef(new Map()),press=useRef(null);
    const preview=photos.find(p=>p.key===previewKey);
    const add=async()=>{
        if(photos.length>=MAX_PHOTOS){onError?.(t('journey:photoPicker.maxPhotos', { MAX_PHOTOS }));return;}
        const source=hasActionSheetHost()?await requestActionSheet({title:t('common:action.addImage'),actions:[{value:'library',label:t('common:action.chooseFromAlbum')},{value:'camera',label:t('common:action.takePhoto')}]}):'library';
        if(!source)return;
        try{
            const files=await pickImages({multiple:source==='library',source,limit:MAX_PHOTOS-photos.length});
            if(!files.length)return;
            const skipped=await draft.addFiles(files);
            if(skipped)onError?.(t('journey:photoPicker.limitReached', { MAX_PHOTOS, skipped }));
        }catch(e){onError?.(e instanceof MediaError?e.message:t('journey:photoPicker.openFailed'));}
    };
    // 长按进入拖动排序；拖动期间阻止页面滚动，松手后按指针位置落位
    const indexAt=(x,y)=>{
        for(const [key,el] of items.current){
            const r=el.getBoundingClientRect();
            if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)return photos.findIndex(p=>p.key===key);
        }
        return -1;
    };
    const blockScroll=e=>e.preventDefault();
    const endDrag=()=>{document.removeEventListener('touchmove',blockScroll);setDrag(null);};
    const onPointerDown=(e,index)=>{
        if(e.button!==undefined&&e.button!==0)return;
        try{e.currentTarget.setPointerCapture(e.pointerId);}catch{/* 旧浏览器 */}
        const start={x:e.clientX,y:e.clientY};
        press.current={index,start,timer:setTimeout(()=>{
            press.current={...press.current,dragging:true};
            document.addEventListener('touchmove',blockScroll,{passive:false});
            setDrag({index,over:index});
            navigator.vibrate?.(10);
        },380)};
    };
    const onPointerMove=e=>{
        const p=press.current;if(!p)return;
        if(!p.dragging){if(Math.hypot(e.clientX-p.start.x,e.clientY-p.start.y)>8){clearTimeout(p.timer);press.current=null;}return;}
        const over=indexAt(e.clientX,e.clientY);
        if(over>=0)setDrag(d=>d&&d.over!==over?{...d,over}:d);
    };
    const onPointerUp=(e,key)=>{
        const p=press.current;press.current=null;
        if(!p)return;
        clearTimeout(p.timer);
        if(p.dragging){const over=indexAt(e.clientX,e.clientY);draft.movePhoto(p.index,over>=0?over:p.index);endDrag();}
        else setPreviewKey(key);
    };
    const onPointerCancel=()=>{if(press.current){clearTimeout(press.current.timer);press.current=null;}endDrag();};
    const failed=photos.filter(p=>p.status==='failed').length,busy=photos.filter(p=>['preparing','ready','uploading'].includes(p.status)).length;
    return <section className="jw-photos-section" aria-label={t('journey:photoPicker.sectionLabel')}>
        <div className="jw-photo-grid" onPointerMove={onPointerMove}>
            {photos.map((p,index)=><div key={p.key} ref={el=>{if(el)items.current.set(p.key,el);else items.current.delete(p.key);}}
                className={`jw-thumb${drag?.index===index?' is-dragging':''}${drag&&drag.over===index&&drag.index!==index?' is-target':''}`}
                role="button" tabIndex={0} aria-label={t('journey:photoPicker.photoLabel', { index: index+1, status: STATUS[p.status]?t('journey:photoPicker.photoStatus', { status: STATUS[p.status] }):'', kind: p.kind?t('journey:photoPicker.photoKind', { kind: KIND_LABEL[p.kind] }):'' })}
                onPointerDown={e=>onPointerDown(e,index)} onPointerUp={e=>onPointerUp(e,p.key)} onPointerCancel={onPointerCancel} onContextMenu={e=>e.preventDefault()}
                onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setPreviewKey(p.key);}}}>
                {p.url?<img src={p.url} alt="" draggable={false}/>:p.mediaId?<PrivatePhoto id={p.mediaId} base={base} token={token} alt=""/>:<span className="jw-photo-placeholder"/>}
                {p.status!=='uploaded'&&<span className={`jw-thumb__status jw-thumb__status--${p.status}`}>{STATUS[p.status]}</span>}
                {p.kind&&p.status==='uploaded'&&<span className="jw-thumb__kind">{KIND_LABEL[p.kind]}</span>}
            </div>)}
            {photos.length<MAX_PHOTOS&&<button type="button" className="jw-thumb jw-thumb--add" onClick={add} aria-label={t('common:action.addImage')}><span aria-hidden="true">＋</span><small>{t('common:action.addImage')}</small></button>}
        </div>
        <p className="jw-muted" aria-live="polite">{tx('journey:photoPicker.counter', { count: photos.length, MAX_PHOTOS, busy: busy?t('journey:photoPicker.counterBusy', { busy }):'', failed: failed?t('journey:photoPicker.counterFailed', { failed }):'', reorderHint: photos.length>1?t('journey:photoPicker.counterReorder'):'' })}</p>
        <ResponsivePanel open={!!preview} onClose={()=>setPreviewKey(null)} title={t('journey:photoPicker.sectionLabel')} kind="journey-photo" desktop="center" mobile="sheet" width="min(520px, calc(100vw - 24px))">
            {preview&&<div className="jw-stack jw-pad">
                <div className="jw-photo-large">{preview.url?<img src={preview.url} alt={t('journey:photoPicker.previewAlt')}/>:preview.mediaId?<PrivatePhoto id={preview.mediaId} base={base} token={token} alt={t('journey:photoPicker.previewAlt')}/>:null}</div>
                {preview.status==='failed'&&<p className="jw-error-text" role="alert">{preview.error||t('common:error.uploadFailed')}</p>}
                <div className="jw-segmented" role="radiogroup" aria-label={t('journey:photoPicker.kindLabel')}>
                    {[['',t('journey:photoPicker.kind.none')],['dish',t('journey:photoPicker.kind.dish')],['menu',t('common:label.menu')],['other',t('journey:photoPicker.kind.other')]].map(([value,label])=><button type="button" key={value} role="radio" aria-checked={(preview.kind||'')===value} onClick={()=>draft.setPhotoKind(preview.key,value)}>{label}</button>)}
                </div>
                <div className="jw-actions">
                    {(()=>{const index=photos.indexOf(preview);return <>
                        <button type="button" disabled={index<=0} onClick={()=>draft.movePhoto(index,index-1)}>{t('journey:photoPicker.moveEarlier')}</button>
                        <button type="button" disabled={index>=photos.length-1} onClick={()=>draft.movePhoto(index,index+1)}>{t('journey:photoPicker.moveLater')}</button>
                    </>;})()}
                    {preview.status==='failed'&&preview.file&&<button type="button" onClick={()=>draft.retryPhoto(preview.key)}>{t('journey:photoPicker.retryUpload')}</button>}
                    <button type="button" className="jw-danger" onClick={()=>{draft.removePhoto(preview.key);setPreviewKey(null);}}>{t('common:action.remove')}</button>
                </div>
                <p className="jw-muted">{t('journey:photoPicker.removeHint')}</p>
            </div>}
        </ResponsivePanel>
    </section>;
}
