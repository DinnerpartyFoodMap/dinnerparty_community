import assert from 'node:assert/strict';
import { createMapActionGate, focusExhibitionVenue } from '../../../src/map/mapActions.js';
let context={map:{},layer:{},mode:'nearby',dataRevision:1,targetRevision:1};
const gate=createMapActionGate(()=>context);
let selected=null, release;
const a=gate.capture();
const work=new Promise(resolve=>{release=resolve;}).then(()=>{if(gate.isCurrent(a))selected='A';});
gate.select(()=>{selected='B';});
release();await work;
assert.equal(selected,'B','keyboard/native selection invalidates an older asynchronous focus');
const b=gate.capture();context={...context,mode:'search'};
assert.equal(gate.isCurrent(b),false,'a mode switch invalidates pending focus without pointer input');
const c=gate.capture();context={...context,targetRevision:2};
assert.equal(gate.isCurrent(c),false,'incoming data invalidates a query against the old target');
assert.equal(gate.isCurrent(c,{data:false}),true,'incoming tiles do not replace the user intent');
const refreshed=gate.refresh(c);
assert.equal(gate.isCurrent(refreshed),true,'the same intent may retry against fresh data');
assert.equal(gate.isCurrent(c),false,'the old query result stays invalid');
const d=gate.capture();context={...context,dataRevision:2};
assert.equal(gate.isCurrent(d),false,'completed data versions are checked after await');
const e=gate.capture();gate.invalidate();
assert.equal(gate.isCurrent(e),false);
const f=gate.capture();context={...context,map:null};
assert.equal(gate.isCurrent(f),false,'destroying a map invalidates its outstanding work');
let marker=null, finishSelection;
const venue={id:'venue'};
const focused=focusExhibitionVenue(venue,{
    select:()=>new Promise(resolve=>{finishSelection=resolve;}),
    isSelected:place=>place===venue,showMarker:place=>{marker=place;}
});
assert.equal(marker,null,'a venue marker waits for its asynchronous selection');
finishSelection(true);await focused;assert.equal(marker,venue);
marker=null;
await focusExhibitionVenue(venue,{select:async()=>true,isSelected:()=>false,showMarker:place=>{marker=place;}});
assert.equal(marker,null,'a superseded venue focus cannot restore the old marker');
console.log('Map action ownership and data-version guards passed');
