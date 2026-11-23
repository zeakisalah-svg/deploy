const { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const roles = Object.freeze({
  admin: ['taxpayers', 'bills', 'payments', 'audit', 'accounts', 'reversals', 'approve-reversal'],
  cashier: ['payments', 'reversals'],
  viewer: []
});
const ttl = 8 * 60 * 60 * 1000;
const dummySalt = randomBytes(16).toString('hex');
const cookieName = 'mms_session';

function migration(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) {
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','cashier','viewer')), salt TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));"
        + ' CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);'
        + ' CREATE INDEX sessions_expiry ON sessions(expires);'
        + ' ALTER TABLE audit ADD COLUMN actor_id INTEGER REFERENCES users(id);'
        + ' ALTER TABLE audit ADD COLUMN digest TEXT;');
      let previous = '';
      for (const entry of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
        previous = digest(entry, previous);
        db.prepare('UPDATE audit SET digest=? WHERE id=?').run(previous, entry.id);
      }
      db.prepare('INSERT INTO schema_migrations VALUES (1,?)').run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function digest(entry, previous) {
  return hash(JSON.stringify([previous, entry.id, entry.date, entry.role, entry.action, entry.actor_id]));
}
function audit(db, role, action, actor = null) {
  const date = new Date().toISOString();
  const previous = db.prepare('SELECT digest FROM audit ORDER BY id DESC LIMIT 1').get()?.digest || '';
  const id = db.prepare('INSERT INTO audit(date,role,action,actor_id) VALUES (?,?,?,?)').run(date,role,action,actor).lastInsertRowid;
  db.prepare('UPDATE audit SET digest=? WHERE id=?').run(digest({id,date,role,action,actor_id:actor},previous),id);
}
function verifyAudit(db) {
  let previous = '';
  for (const entry of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
    if (digest(entry,previous) !== entry.digest) return false;
    previous = entry.digest;
  }
  return true;
}
function createAccount(db, username, password, role, actor = null) {
  if (typeof username !== 'string' || !/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Use a lowercase account name between 3 and 40 characters.');
  if (typeof password !== 'string' || password.length < 15 || password.length > 128) throw new Error('Use a password between 15 and 128 characters.');
  if (!Object.hasOwn(roles,role)) throw new Error('Select a valid role.');
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password,salt,64).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = db.prepare('INSERT INTO users(username,role,salt,password_hash) VALUES (?,?,?,?) ON CONFLICT(username) DO NOTHING').run(username,role,salt,derived).lastInsertRowid;
    const saved = db.prepare('SELECT id, salt FROM users WHERE username=?').get(username);
    if (saved.salt !== salt) throw new Error('That account name is already registered.');
    audit(db,actor?.role || 'system','Created account #' + id,actor?.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function identity(db) {
  let attempts = [];
  let pending = 0;
  function session(request) {
    const token = request.headers.cookie?.match(/(?:^|; *)mms_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!token) return null;
    return db.prepare('SELECT users.id, username, role, token_hash FROM sessions JOIN users ON users.id=user_id WHERE token_hash=? AND expires>? AND active=1').get(hash(token),Date.now()) || null;
  }
  async function login(input, existing) {
    const now = Date.now();
    attempts = attempts.filter(time => time > now - 60_000);
    if (attempts.length >= 12 || pending >= 2) return { limited: true };
    attempts.push(now);
    pending++;
    try {
      const username = typeof input?.username === 'string' ? input.username : '';
      const password = typeof input?.password === 'string' && input.password.length <= 128 ? input.password : '';
      const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
      const actual = await derive(password,user?.salt || dummySalt,64);
      if (!user || !timingSafeEqual(actual,Buffer.from(user.password_hash,'hex'))) return null;
      const token = randomBytes(32).toString('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM sessions WHERE expires<=? OR token_hash=?').run(now,existing?.token_hash || '');
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),user.id,now+ttl);
        audit(db,user.role,'Signed in',user.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { token, id:user.id, username:user.username, role:user.role };
    } finally {
      pending--;
    }
  }
  function logout(user) {
    if (!user) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash);
      audit(db,user.role,'Signed out',user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { session, login, logout };
}
function cookie(token = '') {
  return cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (token ? ttl / 1000 : 0);
}
module.exports = { migration, identity, createAccount, audit, verifyAudit, roles, cookie };
