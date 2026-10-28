const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'numeric-lifecycle-'));
process.env.DB_FILE=path.join(temp,'test.sqlite');process.env.LOG_TO_FILE='false';process.env.LOG_TO_CONSOLE='false';
const {db,init}=require('../../infrastructure/database');
try{
    init();
    assert.ok(db._raw.prepare('PRAGMA table_info(UserPreference)').all().some(x=>x.name==='input_revision'),'a monotonic revision must protect asynchronous profile publication');
    db._raw.prepare("INSERT INTO User(id,username,password) VALUES('u','numeric-test','unused')").run();
    const id=Number(db._raw.prepare("INSERT INTO Place(name) VALUES('test')").run().lastInsertRowid);
    db._raw.prepare('INSERT INTO Favorite(user_id,place_id) VALUES(?,?)').run('u',id);
    const first=db._raw.prepare("SELECT input_revision FROM UserPreference WHERE user_id='u'").get().input_revision;
    db._raw.prepare('DELETE FROM Favorite WHERE user_id=? AND place_id=?').run('u',id);
    const second=db._raw.prepare("SELECT input_revision FROM UserPreference WHERE user_id='u'").get().input_revision;
    assert.ok(second>first,'repeated dirty changes must increment revision');
    db._raw.prepare("UPDATE UserPreference SET status='ready',dirty=0,computed_input_revision=input_revision WHERE user_id='u'").run();
    db._raw.exec('DROP TRIGGER numeric_profile_dirty; ALTER TABLE UserPreference DROP COLUMN computed_input_revision; ALTER TABLE UserPreference DROP COLUMN input_revision;');
    require('../../modules/ratings/services/algorithmSchema').initAlgorithmSchema(db._raw);
    const migrated=db._raw.prepare("SELECT * FROM UserPreference WHERE user_id='u'").get();
    assert.equal(migrated.computed_input_revision,migrated.input_revision,'an existing clean profile keeps its original refresh cadence after schema upgrade');
    console.log('Monotonic profile input and database clock passed.');
}finally{db._raw.close();fs.rmSync(temp,{recursive:true,force:true});}
