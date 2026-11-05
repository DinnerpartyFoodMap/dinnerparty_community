const {db}=require('../../../infrastructure/database');
const {randomUUID}=require('node:crypto');
function revision(){return db._raw.prepare('SELECT revision FROM AlgorithmClock WHERE id=1').get().revision;}
function context(now=Date.now()){return {contract_version:1,dataset_id:process.env.ALGORITHM_DATASET_ID||'primary',snapshot_id:randomUUID(),input_revision:revision(),as_of_ms:now,purpose:'operation'};}
function same(value){return revision()===value;}
function viewerRatings(viewerId,database=db._raw){return new Map(viewerId?database.prepare('SELECT place_id,score,source,updated_at FROM PlaceRating WHERE user_id=?').all(viewerId).map(({place_id,...rating})=>[place_id,rating]):[]);}
function profileRows(){return db._raw.prepare('SELECT * FROM UserPreference').all().map(row=>{const {vector,...rest}=row;return {...rest,vector_b64:Buffer.isBuffer(vector)?vector.toString('base64'):null};});}
module.exports={revision,context,same,profileRows,viewerRatings};
