const { createHash } = require('node:crypto');
const accounts = { billed:['Receivables','Revenue'], paid:['Cash','Receivables'] };

function post(db, kind, source, amount, date) {
  const [debit, credit] = accounts[kind];
  db.prepare('INSERT INTO revenue_ledger(kind,source,amount,posted_at,debit,credit) VALUES (?,?,?,?,?,?)')
    .run(kind,source,amount,date,debit,credit);
}
function migrateRevenue(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) {
      db.exec("CREATE TABLE revenue_ledger (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('billed','paid')), source INTEGER NOT NULL, amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0), posted_at TEXT, debit TEXT NOT NULL, credit TEXT NOT NULL CHECK(debit<>credit), UNIQUE(kind,source));"
        + ' CREATE TABLE payment_requests (request_id TEXT PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES users(id), fingerprint TEXT NOT NULL, payment_id INTEGER NOT NULL REFERENCES payments(id));'
        + ' CREATE INDEX payments_bill ON payments(bill);'
        + ' CREATE INDEX bills_taxpayer ON bills(taxpayer);'
        + ' CREATE INDEX bills_due ON bills(due);');
      for (const bill of db.prepare('SELECT id,amount FROM bills ORDER BY id').all()) post(db,'billed',bill.id,bill.amount,null);
      for (const payment of db.prepare('SELECT id,amount,date FROM payments ORDER BY id').all()) post(db,'paid',payment.id,payment.amount,payment.date);
      db.prepare('INSERT INTO schema_migrations VALUES (2,?)').run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function fingerprint(input) {
  return createHash('sha256').update(JSON.stringify([input.bill,input.amount])).digest('hex');
}
module.exports = { migrateRevenue, post, fingerprint };
