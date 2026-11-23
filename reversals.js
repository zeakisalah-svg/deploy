const { audit } = require('./identity');

function migrateReversals(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) {
      db.exec("CREATE TABLE payment_reversals (id INTEGER PRIMARY KEY, payment_id INTEGER UNIQUE NOT NULL REFERENCES payments(id), reason TEXT NOT NULL, requested_at TEXT NOT NULL, requester_id INTEGER NOT NULL REFERENCES users(id), approved_at TEXT, approver_id INTEGER REFERENCES users(id), CHECK((approved_at IS NULL)=(approver_id IS NULL)), CHECK(approver_id<>requester_id));"
        + ' CREATE VIEW bill_balances AS SELECT bills.*, bills.amount-COALESCE((SELECT SUM(payments.amount) FROM payments LEFT JOIN payment_reversals ON payment_reversals.payment_id=payments.id AND payment_reversals.approved_at IS NOT NULL WHERE payments.bill=bills.id AND payment_reversals.id IS NULL),0) AS balance FROM bills;'
        + ' DROP TRIGGER payment_cap;'
        + " CREATE TRIGGER payment_cap BEFORE INSERT ON payments WHEN NEW.amount>(SELECT balance FROM bill_balances WHERE id=NEW.bill) BEGIN SELECT RAISE(ABORT,'Payment exceeds the outstanding balance'); END;"
        + " CREATE VIEW revenue_postings AS SELECT id,kind,source,amount,posted_at,debit,credit FROM revenue_ledger UNION ALL SELECT -r.id,'reversed',r.id,p.amount,r.approved_at,'Receivables','Cash' FROM payment_reversals r JOIN payments p ON p.id=r.payment_id WHERE r.approved_at IS NOT NULL;");
      db.prepare('INSERT INTO schema_migrations VALUES (3,?)').run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function fail(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}
function reverse(db, route, actor, input, integer, label) {
  const target = integer(input?.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    let id;
    let action;
    if (route === 'reversals') {
      const reason = label(input.reason);
      if (!db.prepare('SELECT 1 FROM payments WHERE id=?').get(target)) fail('Payment does not exist.');
      if (db.prepare('SELECT 1 FROM payment_reversals WHERE payment_id=?').get(target)) fail('This payment already has a reversal request.');
      id = db.prepare('INSERT INTO payment_reversals(payment_id,reason,requested_at,requester_id) VALUES (?,?,?,?)')
        .run(target,reason,new Date().toISOString(),actor.id).lastInsertRowid;
      action = 'Requested payment reversal';
    } else {
      const existing = db.prepare('SELECT * FROM payment_reversals WHERE id=?').get(target);
      if (!existing || existing.approved_at) fail('A pending reversal is required.');
      if (existing.requester_id === actor.id) fail('A different staff account must approve this reversal.');
      db.prepare('UPDATE payment_reversals SET approved_at=?,approver_id=? WHERE id=?').run(new Date().toISOString(),actor.id,target);
      id = target;
      action = 'Approved payment reversal';
    }
    audit(db,actor.role,action+' #'+id,actor.id);
    db.exec('COMMIT');
    return { id, action };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrateReversals, reverse };
