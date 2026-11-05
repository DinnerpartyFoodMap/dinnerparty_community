'use strict';
const {db}=require('../../../infrastructure/database');
function fail(status,message){throw Object.assign(new Error(message),{status,publicMessage:message});}
function prepareEditRating(userId,placeId,{rating,noExperience=false}={}){
 const business=require('../../ratings/services/ratingBusiness'),existing=db._raw.prepare('SELECT * FROM PlaceRating WHERE user_id=? AND place_id=?').get(userId,placeId);
 if(noExperience!==false&&noExperience!==true)fail(400,'纠错选项无效');
 if(rating!==undefined&&rating!==null&&!business.isValidScore(rating))fail(400,'请选择一个评价');
 if(noExperience===true&&rating!=null)fail(400,'仅纠错时无需补评价');
 if(!existing&&rating==null&&!noExperience)fail(400,'请先选择你的评价，或选择仅纠错、没有体验');
 return {rating:existing?null:rating??null,noExperience:noExperience===true,hadRating:!!existing,submittedAt:Date.now(),expectedRevision:db._raw.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?').get(userId,placeId)?.revision||0};
}
// Synchronous part of the enclosing edit transaction. Never overwrite a newer vote.
function commitEditRating(userId,placeId,intent,now=Date.now()){
 if(!intent||intent.rating==null||db._raw.prepare('SELECT 1 FROM PlaceRating WHERE user_id=? AND place_id=?').get(userId,placeId))return;
 const currentRevision=db._raw.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?').get(userId,placeId)?.revision||0;
 if(intent.expectedRevision!==undefined&&intent.expectedRevision!==currentRevision)return;
 require('../../accounts/services/userAccess').requireWritableUser(userId);
 const b=require('../../ratings/services/ratingBusiness'),quota=b.ratingQuota(userId,placeId,now);
 if(!quota.place_counted&&quota.used>=quota.limit)fail(429,`今天已经评价了 ${quota.limit} 家店，明天再来吧`);
 db._raw.prepare("INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at,weight) VALUES(?,?,?,'user',?,?,?)").run(placeId,userId,intent.rating,now,now,require('../../ratings/services/ratingReputation').userRatingWeight(userId));
 const after=db._raw.prepare('SELECT * FROM PlaceRating WHERE place_id=? AND user_id=?').get(placeId,userId);
 db._raw.prepare("INSERT INTO PlaceRatingEvent(user_id,place_id,action,score,quota_day,occurred_at) VALUES(?,?,'rate',?,?,?)").run(userId,placeId,intent.rating,b.quotaDay(now),now);
 const revision=require('../../ratings/services/ratingHistory').appendRatingRevision({userId,placeId,before:null,after,action:'rate',origin:'active',now,surface:'place_edit'});
 if(Number.isSafeInteger(intent.submittedAt)&&intent.submittedAt<=now)db._raw.prepare("UPDATE RatingRevision SET experience_time_ms=?,experience_time_basis='submission' WHERE user_id=? AND place_id=? AND revision=?").run(intent.submittedAt,userId,placeId,revision);
 db._raw.prepare('UPDATE UserPreference SET dirty=1 WHERE user_id=?').run(userId);
}
module.exports={prepareEditRating,commitEditRating};
