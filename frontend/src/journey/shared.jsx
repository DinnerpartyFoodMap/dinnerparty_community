import React,{useEffect,useState} from 'react';
import {getPlatform} from '../platform/env';
import FullPageHeader from "../components/layout/FullPageHeader";
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

/** 已上传的私人图片：带登录凭证读取，转为本地对象地址。 */
export function PrivatePhoto({id,base,token,alt=t('journey:shared.privatePhotoAlt'),className}) {
    const [url,setUrl]=useState('');
    useEffect(()=>{
        const controller=new AbortController();let objectUrl;
        fetch(`${base}/api/journeys/media/${id}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal})
            .then(r=>{if(!r.ok)throw Error();return r.blob();}).then(blob=>{objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}).catch(()=>{});
        return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
    },[id,base,token]);
    return url?<img className={className} src={url} alt={alt} draggable={false}/>:<span className={`jw-photo-placeholder ${className||''}`} aria-label={t('journey:shared.photoLoading')}/>;
}
/** 公开日记图片：每次读取都由服务端检查公开状态，撤回后不再返回。 */
export function PublicPhoto({publicId,id,base,alt=t('journey:shared.publicPhotoAlt'),className}) {
    return <img className={className} src={`${base}/api/public/journeys/${encodeURIComponent(publicId)}/media/${encodeURIComponent(id)}`} alt={alt} loading="lazy"/>;
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
