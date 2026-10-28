import React,{useEffect,useState} from 'react';
import {getPlatform} from '../platform/env';
import FullPageHeader from "../components/layout/FullPageHeader";
import Markdown from '../components/markdown/Markdown';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import { t } from '../i18n/index.js';

// 日记页面共用的小组件与格式化工具。
export const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
export function formatDay(value) {
    if(!value)return t('journey:shared.noDate');
    if(value===today())return t('journey:shared.today');
    const [y,m,d]=value.split('-').map(Number);
    return y===new Date().getFullYear()?t('journey:shared.monthDay', { m, d }):t('journey:shared.fullDate', { y, m, d });
}
export function formatRange(start,end) {return !end||end===start?formatDay(start):`${formatDay(start)} – ${formatDay(end)}`;}
export const CENTER_SOURCE_LABEL={current:t('journey:shared.centerSource.current'),search:t('journey:shared.centerSource.search'),map:t('journey:shared.centerSource.map'),place:t('journey:shared.centerSource.place'),manual:t('journey:shared.centerSource.manual')};
export function centerLabel(center) {
    if(!center)return '';
    const name=center.name||t('journey:shared.selectedMapLocation');
    return `${name} · ${CENTER_SOURCE_LABEL[center.source]||t('journey:shared.centerSource.manual')}`;
}

/** 已上传的私人图片：带登录凭证读取，转为本地对象地址；读取失败时显示可点的重试。 */
export function PrivatePhoto({id,base,token,alt=t('journey:shared.privatePhotoAlt'),className}) {
    const [url,setUrl]=useState(''),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
    useEffect(()=>{
        const controller=new AbortController();let objectUrl;
        setFailed(false);
        fetch(`${base}/api/journeys/media/${id}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal})
            .then(r=>{if(!r.ok)throw Error();return r.blob();}).then(blob=>{objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
        return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
    },[id,base,token,attempt]);
    if(url)return <img className={className} src={url} alt={alt} draggable={false}/>;
    return failed?<PhotoRetry className={className} onRetry={()=>setAttempt(n=>n+1)}/>:<span className={`jw-photo-placeholder ${className||''}`} aria-label={t('journey:shared.photoLoading')}/>;
}
/** 公开日记图片：每次读取都由服务端检查公开状态，撤回后不再返回。加载失败时可重试（附带次数参数，绕过失败的那次请求）。 */
export function PublicPhoto({publicId,id,base,alt=t('journey:shared.publicPhotoAlt'),className}) {
    const [attempt,setAttempt]=useState(0),[failed,setFailed]=useState(false);
    if(failed)return <PhotoRetry className={className} onRetry={()=>{setFailed(false);setAttempt(n=>n+1);}}/>;
    return <img className={className} src={`${base}/api/public/journeys/${encodeURIComponent(publicId)}/media/${encodeURIComponent(id)}${attempt?`?r=${attempt}`:''}`} alt={alt} loading="lazy" onError={()=>setFailed(true)}/>;
}
// 照片可能放在按钮里（点按放大），重试用 span 而不是嵌套按钮，并阻止点击冒泡到外层
function PhotoRetry({className,onRetry}) {
    const retry=e=>{e.preventDefault();e.stopPropagation();onRetry();};
    return <span role="button" tabIndex={0} className={`jw-photo-placeholder jw-photo-retry ${className||''}`} aria-label={t('journey:shared.photoRetry')}
        onClick={retry} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')retry(e);}}>{t('journey:shared.photoRetryShort')}</span>;
}
/**
 * 放大查看一组照片：index 为当前张（null 时关闭），左右按钮与方向键切换，下方写明第几张与说明。
 * render(photo) 返回大图元素，私人与公开图片各自传入读取方式。
 */
export function PhotoViewer({photos,index,onIndex,render}) {
    const open=index!=null&&!!photos[index];
    const current=open?photos[index]:null;
    const go=delta=>onIndex(i=>i==null?i:(i+delta+photos.length)%photos.length);
    useEffect(()=>{
        if(!open||photos.length<2)return undefined;
        const key=e=>{if(e.key==='ArrowLeft')go(-1);if(e.key==='ArrowRight')go(1);};
        window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[open,photos.length]);
    return <ResponsivePanel open={open} onClose={()=>onIndex(null)} title={t('journey:shared.viewerTitle')} kind="journey-photo-viewer" desktop="center" mobile="full" width="min(960px, calc(100vw - 24px))">
        {current&&<figure className="jw-viewer">
            <div className="jw-viewer__stage">{render(current)}</div>
            <figcaption className="jw-viewer__caption">
                {photos.length>1&&<button type="button" onClick={()=>go(-1)} aria-label={t('journey:shared.viewerPrev')}>‹</button>}
                <span>{t('journey:shared.viewerCaption', { index: index+1, total: photos.length, caption: current.caption||'' })}</span>
                {photos.length>1&&<button type="button" onClick={()=>go(1)} aria-label={t('journey:shared.viewerNext')}>›</button>}
            </figcaption>
        </figure>}
    </ResponsivePanel>;
}
/** 全屏页顶栏：返回 · 标题 · 右侧操作。 */
export function PageHeader({title,onBack,backLabel=t('common:action.back'),right,subtitle}) {
    if (getPlatform() === 'ios') return <FullPageHeader title={title} onBack={onBack} backLabel={backLabel} right={right} subtitle={subtitle}/>;
    return <header className="jw-header">
        <button type="button" className="jw-header__back" onClick={onBack} aria-label={backLabel}><span aria-hidden="true">‹</span><span>{backLabel}</span></button>
        <div className="jw-header__title"><h2>{title}</h2>{subtitle&&<small>{subtitle}</small>}</div>
        <div className="jw-header__right">{right}</div>
    </header>;
}
/** 列表行：标题、当前值与说明，整行可点。 */
export function SettingRow({label,value,hint,onClick,expanded,children,ariaLabel}) {
    return <div className="jw-row-group">
        <button type="button" className="jw-setting" onClick={onClick} aria-expanded={expanded} aria-label={ariaLabel}>
            <span className="jw-setting__label">{label}</span>
            <span className="jw-setting__value">{value}{hint&&<small>{hint}</small>}</span>
            <span className="jw-setting__chevron" aria-hidden="true">›</span>
        </button>
        {children}
    </div>;
}
export function Badge({tone='neutral',children}) {return <span className={`jw-badge jw-badge--${tone}`}>{children}</span>;}
export function Notice({tone='info',children,onClose,role}) {
    return <div className={`jw-notice jw-notice--${tone}`} role={role||(tone==='error'?'alert':'status')}>
        <div>{children}</div>{onClose&&<button type="button" className="jw-icon-button" aria-label={t('journey:shared.closeNotice')} onClick={onClose}>×</button>}
    </div>;
}
export function Empty({title,children}) {return <div className="jw-empty"><strong>{title}</strong>{children&&<div>{children}</div>}</div>;}
export function visibilityBadge(entry) {
    if(entry.public_outdated)return <Badge tone="warn">{t('journey:shared.publicOutdated')}</Badge>;
    return entry.visibility==='public'?<Badge tone="primary">{t('journey:common.label.public')}</Badge>:<Badge>{t('journey:common.label.private')}</Badge>;
}
/** 日记里的文字（摘要、正文、各站文字）按 Markdown 显示，与地点描述用同一套渲染与清理规则。 */
export function MarkdownText({text,className,fallback=null}) {
    return <Markdown text={text} className={`jw-md${className?` ${className}`:''}`} fallback={fallback}/>;
}
/**
 * 支持 Markdown 的多行输入：下方提示语法并可切换预览。预览时输入框只是隐藏，
 * 外层 <label> 的关联、受控值与键盘行为都不变。
 */
export function MarkdownField({value,className,...rest}) {
    const [preview,setPreview]=useState(false);
    return <span className="jw-md-field">
        <textarea {...rest} className={className} value={value} style={preview?{display:'none'}:undefined}/>
        {preview&&<span className={`jw-md-preview${className?` ${className}`:''}`} role="region" aria-label={t('common:markdown.previewLabel')}>
            <MarkdownText text={value} fallback={<span className="jw-muted">{t('common:markdown.emptyPreview')}</span>}/></span>}
        <span className="jw-md-field__bar">
            <small className="jw-muted">{t('common:markdown.hint')}</small>
            <button type="button" className="jw-md-toggle" aria-pressed={preview} onClick={e=>{e.preventDefault();setPreview(v=>!v);}}>{preview?t('common:markdown.edit'):t('common:markdown.preview')}</button>
        </span>
    </span>;
}
