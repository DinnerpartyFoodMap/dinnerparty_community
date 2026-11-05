'use strict';
require('dotenv').config({quiet:true});
const {db,init}=require('../../infrastructure/database');
async function main(){
 init();const evidence=require('../../modules/ratings/services/ratingTextEvidence'),adapter=require('../../modules/ratings/services/ratingEstimateAdapter');
 if(process.argv.includes('--compare')){const id=db._raw.prepare("SELECT id FROM Place WHERE moderation_status='visible' LIMIT 1").get()?.id;if(id)await adapter.ratingViews([id]);}
 process.stdout.write(JSON.stringify({mode:evidence.mode(),status:db._raw.prepare('SELECT status,COUNT(*) AS count FROM RatingTextEvidence GROUP BY status').all(),current_weighted_user_places:evidence.factors().size,shadow:adapter.textEvidenceShadow(),note:'Shadow deltas measure score changes, not accuracy without future labels.'},null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;}).finally(()=>db._raw.close());
