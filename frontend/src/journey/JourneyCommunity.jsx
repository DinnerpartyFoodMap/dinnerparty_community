import React,{useEffect,useState} from 'react';
import {request} from './feedback';
import {PageHeader,Notice,Empty} from './shared';
import { t, tx } from '../i18n/index.js';

const KIND_LABEL={search:t('common:action.search'),exposure:t('journey:community.kind.exposure'),click:t('journey:community.kind.click'),favorite:t('journey:community.kind.favorite'),unfavorite:t('journey:community.kind.unfavorite'),correction:t('journey:community.kind.correction'),next:t('journey:community.kind.swap'),confirm_stop:t('journey:community.kind.confirmVisit')};

/**
 * 同好：首期沿用偏好向量匹配、星图与公开收藏夹。同好列表优先，星图为可切换视图；
 * 「我的公开收藏夹」「发现设置」是页面内的明确入口。日记公开与同好设置分别管理。
 */
export default function JourneyCommunity({ctx,nav}) {
    const {base,token,feedback,confirm}=ctx;
    const api=(path,options)=>request(base,token,`/api/community${path}`,options);
    const [section,setSection]=useState('neighbors'),[view,setView]=useState('list');
    const [settings,setSettings]=useState(null),[collections,setCollections]=useState([]),[favorites,setFavorites]=useState([]),[neighbors,setNeighbors]=useState(null),[person,setPerson]=useState(null),[stats,setStats]=useState(null);
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
    const load=async()=>{
        const [c,l,f,n,s]=await Promise.all([api('/consent'),api('/collections'),request(base,token,'/api/favorites'),api('/neighbors'),api('/feedback')]);
        setSettings(c);setCollections(l);setFavorites(f);setNeighbors(n);setStats(s);feedback?.updateConsent(c);
    };
    useEffect(()=>{let active=true;load().catch(e=>{if(active)setError(e.message);});return()=>{active=false;};
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[base,token]);
    const perform=async fn=>{setBusy(true);setError('');setSaved('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const openPerson=p=>perform(async()=>setPerson({...await api(`/users/${p.id}/collections`),similarity:p.similarity,shared:p.shared}));
    const saveSettings=()=>perform(async()=>{const next=await api('/consent',{method:'PUT',body:JSON.stringify(settings)});setSettings(next);feedback?.updateConsent(next);setNeighbors(await api('/neighbors'));setPerson(null);setStats(await api('/feedback'));setSaved(t('journey:community.settingsSaved'));});
    const saveCollection=c=>perform(async()=>{await api(`/collections/${c.id}`,{method:'PUT',body:JSON.stringify({...c,place_ids:c.places.map(p=>p.id)})});await load();setSaved(t('journey:community.collectionSaved'));});
    const editCollection=(id,patch)=>setCollections(list=>list.map(c=>c.id===id?{...c,...patch}:c));
    const list=neighbors?.neighbors||[];
    const emptyState=()=>{
        if(neighbors?.profile_status==='disabled')return <Empty title={t('journey:community.empty.disabledTitle')}>{t('journey:community.empty.disabledHint')}<div className="jw-actions"><button type="button" onClick={()=>setSection('settings')}>{t('journey:community.empty.goToSettings')}</button></div></Empty>;
        if(neighbors?.profile_status==='ready')return <Empty title={t('journey:community.empty.noMatchTitle')}>{t('journey:community.empty.noMatchHint')}</Empty>;
        return <Empty title={t('journey:community.empty.notEnoughTitle')}>{t('journey:community.empty.notEnoughHint')}</Empty>;
    };
    return <div className="jw-page">
        <PageHeader title={t('journey:common.feature.community')} onBack={nav.pop}/>
        <div className="jw-scroll"><div className="jw-content jw-stack" aria-busy={busy}>
            <div className="jw-segmented" role="tablist" aria-label={t('journey:community.tabsLabel')}>
                {[['neighbors',t('journey:common.feature.community')],['collections',t('journey:community.tab.collections')],['settings',t('journey:community.tab.settings')]].map(([id,label])=><button type="button" key={id} role="tab" aria-selected={section===id} onClick={()=>{setSection(id);setSaved('');}}>{label}</button>)}
            </div>
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            {saved&&<Notice tone="success" onClose={()=>setSaved('')}>{saved}</Notice>}
            {!settings&&!error&&<p className="jw-muted">{t('journey:community.loading')}</p>}
            {settings&&section==='neighbors'&&<>
                {list.length?<>
                    <div className="jw-row-between"><p className="jw-muted">{neighbors.notice}</p>
                        <div className="jw-segmented jw-segmented--small" role="radiogroup" aria-label={t('journey:community.viewModeLabel')}>
                            {[['list',t('journey:community.viewMode.list')],['map',t('journey:community.viewMode.map')]].map(([id,label])=><button type="button" key={id} role="radio" aria-checked={view===id} onClick={()=>setView(id)}>{label}</button>)}
                        </div>
                    </div>
                    {view==='map'?<>
                        <p className="jw-muted">{t('journey:community.mapHint')}</p>
                        <svg viewBox="-1.2 -1.2 2.4 2.4" className="jw-taste" role="img" aria-label={t('journey:community.mapLabel')}>
                            {[0.35,0.65,0.95].map(r=><circle key={r} r={r} fill="none" stroke="currentColor" strokeOpacity=".15" strokeWidth=".008"/>)}
                            <circle r=".07" fill="var(--theme-primary)"/><text y=".17" textAnchor="middle" fontSize=".09" fill="currentColor">{t('journey:community.me')}</text>
                            {list.map(p=><g key={p.id} role="button" tabIndex="0" aria-label={t('journey:community.viewCollection', { username: p.username })} onClick={()=>openPerson(p)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPerson(p);}}}>
                                <circle cx={p.x} cy={p.y} r=".045" fill="var(--theme-secondary)"/><title>{p.username} · {Math.round(p.similarity*100)}% · {p.shared.join(t('common:punctuation.listSeparator'))}</title>
                            </g>)}
                        </svg>
                    </>:list.map(p=><button type="button" className="jw-entry" key={p.id} onClick={()=>openPerson(p)}>
                        <span className="jw-avatar jw-avatar--empty" aria-hidden="true">{p.username.slice(0,1)}</span>
                        <span className="jw-entry__body"><strong>{p.username}</strong><small>{tx('journey:community.neighborMeta', { similarity: Math.round(p.similarity*100), confidence: p.confidence, value: p.shared.length?` · ${p.shared.join(' · ')}`:'' })}</small></span>
                    </button>)}
                </>:emptyState()}
                {person&&<section className="jw-card jw-stack" aria-label={t('journey:community.collectionOf', { username: person.user.username })}>
                    <div className="jw-row-between"><strong>{tx('journey:community.collectionOf', { username: person.user.username })}</strong><button type="button" onClick={()=>setPerson(null)}>{t('journey:community.collapse')}</button></div>
                    {person.collections.length?person.collections.map(c=><div key={c.id}><strong>{c.title}</strong><ul>{c.places.map(p=><li key={p.id}>{p.name} · {p.category||t('common:label.uncategorized')}</li>)}</ul></div>)
                        :<p className="jw-muted">{t('journey:community.noPublicCollections')}</p>}
                </section>}
            </>}
            {settings&&section==='collections'&&<>
                <p className="jw-muted">{t('journey:community.collectionsHint')}</p>
                <button type="button" disabled={busy} onClick={()=>perform(async()=>{await api('/collections',{method:'POST',body:JSON.stringify({title:t('journey:community.newCollectionName')})});await load();})}>{t('journey:community.newCollection')}</button>
                {!collections.length&&<Empty title={t('journey:community.noCollectionsTitle')}>{t('journey:community.noCollectionsHint')}</Empty>}
                {collections.map(c=><section key={c.id} className="jw-card jw-stack">
                    <input aria-label={t('journey:community.collectionNameLabel')} value={c.title} maxLength={80} onChange={e=>editCollection(c.id,{title:e.target.value})}/>
                    <label className="jw-check"><input type="checkbox" checked={c.is_public} onChange={e=>editCollection(c.id,{is_public:e.target.checked})}/><span>{t('journey:community.makePublic')}</span></label>
                    <div className="jw-scroll-box">{favorites.length?favorites.map(f=>{const id=Number(f.place_id||f.id);return <label key={id} className="jw-check"><input type="checkbox" checked={c.places.some(p=>p.id===id)} onChange={e=>editCollection(c.id,{places:e.target.checked?[...c.places,{id,name:f.name}]:c.places.filter(p=>p.id!==id)})}/><span>{f.name}</span></label>;}):<p className="jw-muted">{t('journey:community.noFavorites')}</p>}</div>
                    <div className="jw-actions"><button type="button" disabled={busy} onClick={()=>saveCollection(c)}>{t('journey:community.saveCollection')}</button><button type="button" disabled={busy} onClick={()=>perform(async()=>{if(await confirm(t('journey:community.confirmDeleteCollection', { title: c.title }))){await api(`/collections/${c.id}`,{method:'DELETE'});await load();}})}>{t('common:action.delete')}</button></div>
                </section>)}
            </>}
            {settings&&section==='settings'&&<>
                <p className="jw-muted">{t('journey:community.settingsHint')}</p>
                <label className="jw-field"><span className="jw-field__label">{t('journey:community.tagsLabel')}</span><input value={settings.tags.join(t('journey:community.tagSeparator'))} maxLength={500} onChange={e=>setSettings({...settings,tags:e.target.value.split(/[,，]/)})}/></label>
                <label className="jw-check"><input type="checkbox" checked={settings.discovery} onChange={e=>setSettings({...settings,discovery:e.target.checked})}/><span>{t('journey:community.consent.discovery')}</span></label>
                <label className="jw-check"><input type="checkbox" checked={settings.feedback} onChange={e=>setSettings({...settings,feedback:e.target.checked,research:e.target.checked?settings.research:false})}/><span>{t('journey:community.consent.feedback')}</span></label>
                <p className="jw-muted">{t('journey:community.consent.feedbackHint')}</p>
                <label className="jw-check"><input type="checkbox" disabled={!settings.feedback} checked={settings.research} onChange={e=>setSettings({...settings,research:e.target.checked})}/><span>{t('journey:community.consent.research')}</span></label>
                <button type="button" className="jw-primary" disabled={busy} onClick={saveSettings}>{t('journey:community.saveSettings')}</button>
                <p className="jw-muted">{stats?.counts.map(s=>`${KIND_LABEL[s.kind]||s.kind} ${s.count}`).join(' · ')||t('journey:community.noInteractions')}</p>
                <button type="button" disabled={busy} onClick={()=>perform(async()=>{const c=await api('/feedback',{method:'DELETE'});setSettings(c);feedback?.updateConsent(c);setStats(await api('/feedback'));setSaved(t('journey:community.interactionsCleared'));})}>{t('journey:community.clearInteractions')}</button>
            </>}
        </div></div>
    </div>;
}
