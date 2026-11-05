'use strict';
require('dotenv').config({quiet:true});
const {db,init}=require('../../infrastructure/database');
try{init();const result=require('../../modules/places/services/placeRevisions').backfillEditComments({apply:process.argv.includes('--apply'),limit:Number(process.env.EDIT_COMMENT_BACKFILL_LIMIT||500)});process.stdout.write(JSON.stringify(result)+'\n');}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}finally{db._raw.close();}
