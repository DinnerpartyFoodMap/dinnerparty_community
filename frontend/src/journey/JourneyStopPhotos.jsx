import React,{useEffect,useState} from 'react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import {PrivatePhoto,Notice} from './shared';
import { t, tx } from '../i18n/index.js';

export const STOP_PHOTO_LIMIT=12;

/**
 * 为某一站选照片：本篇已有的照片、私人图片空间里之前上传过的图片，或从本机再添加。
 * 选中的图片随该站保存（不在本篇里的会一并加入本篇照片）；取消选中只从这一站移出，图片仍留在本篇。
 */
export default function JourneyStopPhotos({open,stop,document,ctx,busy,notice,onNoticeClose,onToggle,onUpload,onClose}) {
    const {api,base,token}=ctx;
    const [library,setLibrary]=useState(null),[error,setError]=useState('');
    useEffect(()=>{
        if(!open)return undefined;
        let alive=true;setError('');
        api('/media').then(list=>{if(alive)setLibrary(list);}).catch(e=>{if(alive)setError(e.message);});
        return()=>{alive=false;};
    },[open,api]);
    const entry=document?.entry_media_ids||[];
    const others=(library||[]).map(m=>m.id).filter(id=>!entry.includes(id));
    const selected=stop?.media_ids||[];
    const tile=id=>{const on=selected.includes(id);return <button type="button" key={id} aria-pressed={on} disabled={busy}
        aria-label={on?t('journey:stopPhotos.deselect'):t('journey:stopPhotos.select')} onClick={()=>onToggle(id)}>
        <PrivatePhoto id={id} base={base} token={token} alt=""/>{on&&<span aria-hidden="true">✓</span>}</button>;};
    return <ResponsivePanel open={open&&!!stop} onClose={onClose} title={stop?t('journey:stopPhotos.title', { name: stop.name }):''} kind="journey-stop-photos" desktop="center" mobile="sheet" width="min(560px, calc(100vw - 24px))">
        {stop&&<div className="jw-stack jw-pad">
            <div className="jw-row-between">
                <small className="jw-muted" role="status">{tx('journey:stopPhotos.count', { count: selected.length, max: STOP_PHOTO_LIMIT })}</small>
                <button type="button" disabled={busy||selected.length>=STOP_PHOTO_LIMIT} onClick={onUpload}>{busy?t('journey:stopPhotos.uploading'):t('journey:stopPhotos.fromDevice')}</button>
            </div>
            {notice&&<Notice tone="warn" onClose={onNoticeClose}>{notice}</Notice>}
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            <section className="jw-stack" aria-label={t('journey:stopPhotos.entrySection')}>
                <strong>{t('journey:stopPhotos.entrySection')}</strong>
                {entry.length?<div className="jw-photo-choice">{entry.map(tile)}</div>:<p className="jw-muted">{t('journey:stopPhotos.entryEmpty')}</p>}
            </section>
            <section className="jw-stack" aria-label={t('journey:stopPhotos.librarySection')}>
                <strong>{t('journey:stopPhotos.librarySection')}</strong>
                {!library&&!error&&<p className="jw-muted">{t('journey:common.status.fetching')}</p>}
                {library&&(others.length?<div className="jw-photo-choice">{others.map(tile)}</div>:<p className="jw-muted">{t('journey:stopPhotos.libraryEmpty')}</p>)}
                <p className="jw-muted">{t('journey:stopPhotos.libraryHint')}</p>
            </section>
            <div className="jw-actions"><button type="button" className="jw-primary" onClick={onClose}>{t('journey:stopPhotos.done')}</button></div>
        </div>}
    </ResponsivePanel>;
}
