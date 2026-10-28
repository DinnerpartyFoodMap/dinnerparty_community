const express=require('express'),{timingSafeEqual}=require('node:crypto');
const router=express.Router();
router.get('/:id/status',(req,res)=>{
    res.set('Cache-Control','no-store');const token=process.env.RATING_EVIDENCE_STATUS_TOKEN,actual=req.get('Authorization')||'',expected=`Bearer ${token}`;
    if(!token||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return res.status(401).json({error:'unauthorized'});
    if(!/^[a-f0-9-]{36}$/.test(req.params.id))return res.status(400).json({error:'invalid_id'});
    res.json(require('../services/ratingResearchBundles').bundleStatus(req.params.id));
});
module.exports=router;
