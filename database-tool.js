const { existsSync, closeSync, openSync, unlinkSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { verifyAudit } = require('./identity');

function check(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed.');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed.');
  const columns = db.prepare("PRAGMA table_info('audit')").all();
  if (!columns.length) throw new Error('The selected database does not contain MMS audit records.');
  if (columns.some(column => column.name === 'digest') && !verifyAudit(db)) throw new Error('Audit digest check failed.');
}
async function run() {
  const [action, first, second] = process.argv.slice(2);
  if (!first || !['backup','verify','restore'].includes(action) || (action === 'restore' && !second)) {
    throw new Error('Usage: node database-tool.js backup <file> | verify <file> | restore <backup> <new file>');
  }
  const sourcePath = resolve(action === 'backup' ? process.env.MMS_DB || join(__dirname,'mms-demo.sqlite') : first);
  const source = new DatabaseSync(sourcePath,{readOnly:true});
  try {
    check(source);
    if (action !== 'verify') {
      const target = resolve(action === 'backup' ? first : second);
      if (existsSync(target)) throw new Error('Choose a destination that does not already exist.');
      closeSync(openSync(target,'wx'));
      try {
        await backup(source,target);
        const recovered = new DatabaseSync(target,{readOnly:true});
        try { check(recovered); } finally { recovered.close(); }
      } catch (error) {
        unlinkSync(target);
        throw error;
      }
    }
    console.log('MMS database ' + action + ' verified.');
  } finally { source.close(); }
}
run().catch(error => {console.error(error.message);process.exitCode=1;});
