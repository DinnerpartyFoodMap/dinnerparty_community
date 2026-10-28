const path=require('node:path');
require('dotenv').config({path:path.resolve(__dirname,'../../.env'),quiet:true});
const {db,init}=require('../../infrastructure/database');
try{init();const args=process.argv.slice(2),index=args.indexOf('--output');console.log(JSON.stringify(require('../../modules/ratings/services/ratingResearchBundles').exportBundle({apply:args.includes('--apply'),...(index>=0?{output:args[index+1]}:{})})));}
catch(e){console.error(e.message);process.exitCode=1;}finally{db._raw.close();}
