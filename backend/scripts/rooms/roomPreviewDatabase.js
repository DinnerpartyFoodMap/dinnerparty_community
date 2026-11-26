const path = require('node:path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { backendPath } = require('../../infrastructure/paths');

function openSnapshot(file) {
    const database = new Database(file ? path.resolve(file) : backendPath('snapshot.sqlite'), {
        readonly: true, fileMustExist: true
    });
    try {
        sqliteVec.load(database);
    } catch (error) {
        console.error(`地点向量扩展不可用，将使用快照中可直接读取的数据（${error.message}）`);
    }
    return database;
}

module.exports = { openSnapshot };
