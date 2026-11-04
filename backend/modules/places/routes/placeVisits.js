const router=require('express').Router();
router.use(require('../../accounts/middleware/auth').requireAuth);
function enabledFor(req){return process.env.PLACE_VISIT_MODE==='active'||process.env.PLACE_VISIT_MODE==='trial'&&String(process.env.PLACE_VISIT_TRIAL_USERS||'').split(',').map(x=>x.trim()).includes(String(req.user.id));}
router.get('/status',(req,res)=>res.set('Cache-Control','no-store').json({enabled:enabledFor(req)}));
router.use((req,res,next)=>{
 const mode=process.env.PLACE_VISIT_MODE;
 const trial=mode==='trial'&&String(process.env.PLACE_VISIT_TRIAL_USERS||'').split(',').map(x=>x.trim()).includes(String(req.user.id));
 if(mode!=='active'&&!trial)return res.status(503).json({enabled:false,error:'到访推断尚未启用'});
 next();
});
const service=require('../services/placeVisitEvidence');
router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
function run(fn){return(req,res,next)=>{try{res.json(fn(req));}catch(e){if(e.publicMessage)return res.status(e.status||400).json({error:e.publicMessage});next(e);}};}
router.post('/:placeId/view',run(req=>service.view(req.user.id,Number(req.params.placeId))));
router.post('/:placeId/evidence',run(req=>service.infer(req.user.id,Number(req.params.placeId),req.body||{})));
router.post('/:placeId/answer',run(req=>service.answer(req.user.id,Number(req.params.placeId),req.body?.id,req.body?.answer)));
module.exports=router;
