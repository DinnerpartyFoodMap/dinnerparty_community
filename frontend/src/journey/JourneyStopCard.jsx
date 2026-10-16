import React from 'react';
import {eventId} from './feedback';
import {PrivatePhoto,Badge} from './shared';
import {located,needsReview,excerptText,distanceMeters,formatDistance} from './reviewUtils';
import { t, tx } from '../i18n/index.js';

const MAP_ACTION={link:t('journey:stopCard.mapAction.link'),create:t('journey:stopCard.mapAction.create'),conflict:t('journey:stopCard.mapAction.conflict')};

/** 一站一卡：照片、店名或“待选店”、可直接编辑的这一站文字与位置；排序、在下方添加与移除直接可用，其余编辑折叠在「补充信息」中。 */
export default function JourneyStopCard({stop,index,total,document,expanded,onToggle,editStop,removeStop,moveStop,addBelow,link,visibility,
    ctx,center,onPickPoint,onChooseShop,editingSaved}) {
    const {base,token}=ctx;
    const pending=needsReview(stop);
    const excerpt=excerptText(stop);
    const sourceText=(stop.excerpts||[]).map(e=>e.text).join(t('journey:stopCard.excerptSeparator'));
    // 文字框直接编辑：与原文摘录一致时不算编辑；清空时这些原文回到“待归属的原文”，可以再归到别处
    const editText=value=>editStop(value===sourceText?{excerpt_edited:''}:!value.trim()?{excerpt_edited:'',excerpts:[]}:{excerpt_edited:value});    const distance=center&&located(stop)?distanceMeters(center,stop):null;
    const entryPhotos=document.entry_media_ids||[];
    const toggleMedia=id=>editStop({media_ids:stop.media_ids.includes(id)?stop.media_ids.filter(m=>m!==id):[...stop.media_ids,id].slice(0,12)});
    const chips=[];
    if(stop.confirmed)chips.push(<Badge key="ok" tone="success">{t('journey:stopCard.badge.confirmed')}</Badge>);
    else if(stop.location_resolution==='deferred')chips.push(<Badge key="later">{t('journey:stopCard.badge.later')}</Badge>);
    else if(pending)chips.push(<Badge key="todo" tone="warn">{t('journey:stopCard.badge.pending')}</Badge>);
    if(!located(stop))chips.push(<Badge key="loc">{t('journey:stopCard.badge.unlocated')}</Badge>);
    return <article className={`jw-stop${pending?' is-pending':''}`} id={`jw-stop-${stop.id}`} aria-label={t('journey:stopCard.ariaLabel', { index: index+1, name: stop.name })}>
        <div className="jw-stop__head">
            <span className="jw-stop__index" aria-hidden="true">{index+1}</span>
            <div className="jw-stop__title">
                <strong>{stop.name==='待选店'?<span className="jw-muted-strong">{t('journey:stopCard.pendingShop')}</span>:stop.name}</strong>
                <span className="jw-stop__chips">{chips}</span>
            </div>
        </div>
        {!!stop.media_ids.length&&<div className="jw-strip">{stop.media_ids.map(id=><PrivatePhoto key={id} id={id} base={base} token={token} className="jw-strip__img" alt={t('journey:stopCard.photosAlt')}/>)}</div>}
        <div className="jw-stop__text">
            <span className="jw-stop__text-label">{stop.excerpt_edited?t('journey:common.label.authorEdited'):sourceText?t('journey:common.label.originalExcerpt'):t('journey:stopCard.textLabel')}{visibility==='public'?t('journey:stopCard.textPublicNote'):''}
                {!!stop.excerpt_edited&&!!sourceText&&<button type="button" className="jw-link" onClick={()=>editStop({excerpt_edited:''})}>{t('journey:stopCard.restoreExcerpt')}</button>}</span>
            <textarea aria-label={t('journey:stopCard.textAriaLabel', { index: index+1 })} className={`jw-excerpt-input${stop.excerpt_edited?' is-edited':''}`} rows={Math.min(8,Math.max(2,Math.ceil(excerpt.length/28)))} maxLength={2000}
                value={excerpt} placeholder={t('journey:stopCard.textPlaceholder')} onChange={e=>editText(e.target.value)}/>
        </div>
        {!!stop.dishes?.length&&<p className="jw-muted">{tx('journey:stopCard.dishes', { dishes: stop.dishes.join(t('common:punctuation.listSeparator')) })}</p>}
        <p className="jw-stop__place">{located(stop)?`${stop.address||(stop.place_id?t('journey:stopCard.localMarker'):t('journey:stopCard.located'))}${distance!=null?t('journey:stopCard.distanceFromCenter', { distance: formatDistance(distance) }):''}`:t('journey:stopCard.unlocatedHint')}</p>

        {pending&&<div className="jw-stop__actions">
            {!!stop.candidates?.length&&<button type="button" onClick={onChooseShop}>{t('journey:common.action.chooseShop')}</button>}
            <button type="button" onClick={onPickPoint}>{t('journey:stopCard.pickPoint')}</button>
            <button type="button" onClick={()=>editStop({location_resolution:'deferred',confirmed:false})}>{t('journey:stopCard.badge.later')}</button>
        </div>}
        {!pending&&!stop.confirmed&&stop.location_resolution==='deferred'&&<div className="jw-stop__actions"><button type="button" onClick={()=>editStop({location_resolution:'pending'})}>{t('journey:stopCard.continueReview')}</button></div>}
        <button type="button" className={`jw-confirm${stop.confirmed?' is-on':''}`} aria-pressed={stop.confirmed}
            onClick={()=>editStop(stop.confirmed?{confirmed:false,location_resolution:'pending'}:{confirmed:true,visit_status:'visited',location_resolution:'pending'})}>
            {stop.confirmed?t('journey:stopCard.confirmed'):t('journey:stopCard.confirmLocation')}
        </button>

        {visibility==='public'&&<div className="jw-publish-box">
            {link?.action==='conflict'&&<div className="jw-conflict" role="group" aria-label={t('journey:stopCard.duplicateLabel')}>
                <p>{t('journey:stopCard.duplicateHint')}</p>
                {link.duplicates.map(d=><div key={d.id} className="jw-conflict__row">
                    <span><strong>{d.name}</strong><small>{d.address||t('journey:stopCard.localMarkerShort')} · {formatDistance(d.distance_m)}</small></span>
                    <span className="jw-inline-actions">
                        <button type="button" onClick={()=>editStop({place_id:d.id,source:'local',lng:d.lng,lat:d.lat,address:d.address||'',name:d.name,external_id:''})}>{t('journey:stopCard.sameShop')}</button>
                        <button type="button" onClick={()=>editStop({duplicate_ack:[...new Set([...(stop.duplicate_ack||[]),d.id])]})}>{t('journey:stopCard.differentShop')}</button>
                    </span>
                </div>)}
            </div>}
            <p className="jw-muted">{tx('journey:stopCard.mapLine', { action: link?MAP_ACTION[link.action]||link.message:t('journey:stopCard.previewOnSave') })}</p>
            {/* 早先的草稿可能单独隐藏过某一站；公开开关已移除，只保留恢复入口 */}
            {stop.public===false&&<p className="jw-muted">{t('journey:stopCard.wasPrivate')}<button type="button" className="jw-link" onClick={()=>editStop({public:true})}>{t('journey:stopCard.makePublic')}</button></p>}
            <label className="jw-check"><input type="checkbox" checked={stop.map_link!==false} onChange={e=>editStop({map_link:e.target.checked})}/><span>{t('journey:stopCard.mapLink')}</span></label>
        </div>}

        <div className="jw-stop__tools" role="group" aria-label={t('journey:stopCard.toolsLabel', { index: index+1 })}>
            <button type="button" disabled={index===0} onClick={()=>moveStop(-1)} aria-label={t('journey:stopCard.moveEarlierLabel')}><span aria-hidden="true">↑</span> {t('journey:stopCard.moveUp')}</button>
            <button type="button" disabled={index===total-1} onClick={()=>moveStop(1)} aria-label={t('journey:stopCard.moveLaterLabel')}><span aria-hidden="true">↓</span> {t('journey:stopCard.moveDown')}</button>
            <button type="button" disabled={total>=60} onClick={addBelow}><span aria-hidden="true">＋</span> {t('journey:stopCard.addBelow')}</button>
            <button type="button" className="jw-danger" onClick={removeStop} aria-label={t('journey:stopCard.removeLabel')}>{t('common:action.remove')}</button>
        </div>

        <details className="jw-more" open={expanded} onToggle={e=>{if(e.currentTarget.open!==expanded)onToggle(e.currentTarget.open);}}>
            <summary>{t('journey:stopCard.moreInfo')}</summary>
            {expanded&&<div className="jw-stack">
                <label className="jw-field"><span className="jw-field__label">{t('journey:stopCard.field.name')}</span><input value={stop.name} maxLength={160} onChange={e=>editStop({name:e.target.value})}/></label>
                <label className="jw-field"><span className="jw-field__label">{t('journey:stopCard.field.time')}</span><input type="datetime-local" value={stop.at} onChange={e=>editStop({at:e.target.value})}/></label>
                <label className="jw-field"><span className="jw-field__label">{t('journey:stopCard.field.mood')}</span><select value={stop.mood} onChange={e=>editStop({mood:e.target.value})}>{['','😊','🥰','😋','😌','🥹','😴','😐','😢','😤'].map(m=><option key={m} value={m}>{m||t('journey:stopCard.mood.none')}</option>)}</select></label>
                {!stop.place_id&&<label className="jw-field"><span className="jw-field__label">{t('journey:stopCard.field.category')}</span><input maxLength={16} value={stop.category||''} onChange={e=>editStop({category:e.target.value})}/></label>}
                <div className="jw-field"><span className="jw-field__label">{t('journey:stopCard.field.expenses')}</span>
                    {stop.expenses.map((expense,i)=><div className="jw-actions" key={expense.id}>
                        <input aria-label={t('journey:stopCard.expenseAmount', { index: index+1, i: i+1 })} type="number" min="0" max="1000000" step="0.01" value={expense.amount} onChange={e=>editStop({expenses:stop.expenses.map(x=>x.id===expense.id?{...x,amount:e.target.value}:x)})}/>
                        <input aria-label={t('journey:stopCard.expenseNote', { index: index+1, i: i+1 })} maxLength={100} value={expense.note} onChange={e=>editStop({expenses:stop.expenses.map(x=>x.id===expense.id?{...x,note:e.target.value}:x)})}/>
                        <button type="button" onClick={()=>editStop({expenses:stop.expenses.filter(x=>x.id!==expense.id)})}>{t('common:action.remove')}</button>
                    </div>)}
                    <button type="button" disabled={stop.expenses.length>=30} onClick={()=>editStop({expenses:[...stop.expenses,{id:eventId(),amount:'',note:''}]})}>{t('journey:stopCard.addExpense')}</button>
                </div>
                {!!entryPhotos.length&&<div className="jw-field"><span className="jw-field__label">{t('journey:stopCard.photosLabel')}</span>
                    <div className="jw-photo-choice">{entryPhotos.map(id=><button type="button" key={id} aria-pressed={stop.media_ids.includes(id)} onClick={()=>toggleMedia(id)} aria-label={stop.media_ids.includes(id)?t('journey:stopCard.removePhoto'):t('journey:stopCard.usePhoto')}>
                        <PrivatePhoto id={id} base={base} token={token} alt=""/>{stop.media_ids.includes(id)&&<span aria-hidden="true">✓</span>}
                    </button>)}</div>
                </div>}
                {editingSaved&&<label className="jw-field"><span className="jw-field__label">{t('journey:stopCard.field.correction')}</span><select value={stop.correction_reason||''} onChange={e=>editStop({correction_reason:e.target.value})}><option value="">{t('journey:stopCard.correction.none')}</option><option value="wrong_branch">{t('journey:stopCard.correction.wrongBranch')}</option><option value="wrong_place">{t('journey:stopCard.correction.wrongPlace')}</option><option value="not_visited">{t('journey:stopCard.correction.notVisited')}</option><option value="privacy">{t('journey:stopCard.correction.privacy')}</option><option value="other">{t('journey:stopCard.correction.other')}</option></select></label>}
            </div>}
        </details>
    </article>;
}
