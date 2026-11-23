const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { migration, identity, createAccount, audit, verifyAudit, roles: permissions, cookie } = require('./identity');
const { migrateRevenue, post, fingerprint } = require('./revenue');
const { migrateReversals, reverse } = require('./reversals');
const demo = process.argv.includes('--demo');
const demoSecret = demo ? require('node:crypto').randomBytes(32).toString('hex') : null;
const provideAccount = process.argv.includes('--create-account');

const db = new DatabaseSync(demo ? ':memory:' : process.env.MMS_DB || join(__dirname, 'mms-demo.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS taxpayers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bills (id INTEGER PRIMARY KEY, taxpayer INTEGER NOT NULL REFERENCES taxpayers(id), description TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), due TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, bill INTEGER NOT NULL REFERENCES bills(id), amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, date TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS payment_cap BEFORE INSERT ON payments
  WHEN NEW.amount + COALESCE((SELECT SUM(amount) FROM payments WHERE bill = NEW.bill), 0) > (SELECT amount FROM bills WHERE id = NEW.bill)
  BEGIN SELECT RAISE(ABORT, 'Payment exceeds the outstanding balance'); END;
`);
if (!db.prepare("SELECT 1 FROM settings WHERE key='seeded'").get()) {
  db.exec(`BEGIN IMMEDIATE;
    INSERT INTO taxpayers (name, category) VALUES ('Harbour Market Cooperative','Business'), ('Cedar Court Properties','Property'), ('North Gate Traders','Business');
    INSERT INTO bills (taxpayer, description, amount, due) VALUES (1,'Market licence',85000,'2020-01-31'), (2,'Property assessment',150000,'2099-01-31'), (3,'Trading permit',50000,'2099-01-31');
    INSERT INTO payments (bill, amount, date) VALUES (1,30000,strftime('%Y-%m-%dT%H:%M:%fZ','now')), (3,50000,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO audit (date, role, action) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','Loaded synthetic demo records');
    INSERT INTO settings VALUES ('seeded');
    COMMIT;`);
}

migration(db);
migrateRevenue(db);
migrateReversals(db);
if (!verifyAudit(db)) throw new Error('Audit integrity check failed. Inspect the database before starting MMS.');
if (provideAccount) {
  try {
    createAccount(db,process.env.MMS_ACCOUNT,process.env.MMS_PASSWORD,process.env.MMS_ROLE || 'admin');
    console.log('Local account created.');
  } finally {
    db.close();
  }
  return;
}
if (demo) {
  createAccount(db,'admin',demoSecret,'admin');
}
const auth = identity(db);

const files = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript']
};
function snapshot(role) {
  return {
    taxpayers: db.prepare('SELECT * FROM taxpayers ORDER BY id DESC').all(),
    bills: db.prepare(`SELECT * FROM bill_balances ORDER BY id DESC`).all(),
    payments: db.prepare('SELECT payments.*, payment_reversals.approved_at AS reversed_at FROM payments LEFT JOIN payment_reversals ON payment_reversals.payment_id=payments.id ORDER BY payments.id DESC').all(),
    reversals: permissions[role].includes('reversals') ? db.prepare('SELECT * FROM payment_reversals ORDER BY id DESC').all() : [],
    ledger: permissions[role].includes('audit') ? db.prepare('SELECT * FROM revenue_postings ORDER BY posted_at DESC, id DESC LIMIT 100').all() : [],
    audit: permissions[role].includes('audit') ? db.prepare('SELECT * FROM audit ORDER BY id DESC').all() : []
  };
}
function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) invalid('Enter text between 1 and 120 characters.');
  return value.trim();
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000000000) invalid('Enter a valid positive number.');
  return value;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('Enter a valid due date.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid('Enter a valid due date.');
  return value;
}
function mutate(resource, input, actor, requestKey) {
  if (!input || typeof input !== 'object') invalid('Invalid request.');
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    let id;
    let action;
    if (resource === 'taxpayers') {
      id = db.prepare('INSERT INTO taxpayers (name, category) VALUES (?,?)').run(label(input.name), label(input.category)).lastInsertRowid;
      action = 'Registered taxpayer';
    } else if (resource === 'bills') {
      const taxpayer = integer(input.taxpayer);
      if (!db.prepare('SELECT 1 FROM taxpayers WHERE id = ?').get(taxpayer)) invalid('Taxpayer does not exist.');
      id = db.prepare('INSERT INTO bills (taxpayer, description, amount, due) VALUES (?,?,?,?)').run(taxpayer, label(input.description), integer(input.amount), validDate(input.due)).lastInsertRowid;
      post(db,'billed',id,input.amount,now);
      action = 'Issued assessment and bill';
    } else {
      const bill = integer(input.bill);
      const amount = integer(input.amount);
      if (requestKey) {
        const previous = db.prepare('SELECT * FROM payment_requests WHERE request_id=?').get(requestKey);
        if (previous) {
          if (previous.actor_id !== actor.id || previous.fingerprint !== fingerprint(input)) {
            const error = new Error('This payment request identifier was already used.');
            error.status = 409;
            throw error;
          }
          db.exec('COMMIT');
          return { id:previous.payment_id, action:'Payment already recorded', replayed:true };
        }
      }
      const record = db.prepare('SELECT balance FROM bill_balances WHERE id = ?').get(bill);
      if (!record || amount > record.balance) invalid('Payment exceeds the outstanding balance or the bill does not exist.');
      id = db.prepare('INSERT INTO payments (bill, amount, date) VALUES (?,?,?)').run(bill, amount, now).lastInsertRowid;
      post(db,'paid',id,amount,now);
      if (requestKey) db.prepare('INSERT INTO payment_requests VALUES (?,?,?,?)').run(requestKey,actor.id,fingerprint(input),id);
      action = 'Recorded payment and issued receipt';
    }
    audit(db,actor.role,action + ' #' + id,actor.id);
    db.exec('COMMIT');
    return { id, action };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
const port = Number(process.env.MMS_PORT || 8765);
const address = 'http://127.0.0.1:' + port;
async function json(request) {
  if (request.headers['content-type'] !== 'application/json') {
    const error = new Error('Expected JSON.');
    error.status = 415;
    throw error;
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) {
      const error = new Error('Request is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { invalid('Invalid JSON.'); }
}
createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (request.headers.host !== '127.0.0.1:' + port || (request.headers.origin && request.headers.origin !== address)) {
      return reply(response, 403, { error: 'Use the local MMS address.' });
    }
    if (request.method === 'GET' && Object.hasOwn(files, request.url)) {
      const [file, type] = files[request.url];
      const body = readFileSync(join(__dirname, file));
      response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(body);
    }
    const route = request.url.replace(/^\/api\/(?:v1\/)?/, '');
    const actor = auth.session(request);
    if (request.method === 'GET' && route === 'session') {
      return reply(response, 200, { user: actor && { id: actor.id, username: actor.username, role: actor.role }, demo });
    }
    if (request.method === 'POST' && route === 'login') {
      const input = await json(request);
      const credentials = demo ? { username:input?.username === 'admin' ? 'admin' : '', password:demoSecret } : input;
      const result = await auth.login(credentials, actor);
      if (result?.limited) return reply(response, 429, { error: 'Too many sign-in attempts. Try again in a minute.' });
      if (!result) return reply(response, 401, { error: 'Invalid account name or password.' });
      response.setHeader('Set-Cookie', cookie(result.token));
      return reply(response, 200, { id: result.id, username: result.username, role: result.role });
    }
    if (!actor) return reply(response, 401, { error: 'Sign in to continue.' });
    if (request.method === 'POST' && route === 'logout') {
      await json(request);
      auth.logout(actor);
      response.setHeader('Set-Cookie', cookie());
      return reply(response, 200, { signedOut: true });
    }
    if (request.method === 'GET' && route === 'state') return reply(response, 200, snapshot(actor.role));
    if (request.method !== 'POST' || !['taxpayers', 'bills', 'payments', 'accounts', 'reversals', 'approve-reversal'].includes(route)) {
      return reply(response, 404, { error: 'Route not found.' });
    }
    if (!permissions[actor.role].includes(route)) return reply(response, 403, { error: 'Your account does not have permission.' });
    const input = await json(request);
    if (route === 'accounts') {
      try { createAccount(db,input?.username,input?.password,input?.role,actor); }
      catch (error) { if (error.code) throw error; invalid(error.message); }
      return reply(response,201,{ action:'Created staff account' });
    }
    if (route === 'reversals' || route === 'approve-reversal') return reply(response,201,reverse(db,route,actor,input,integer,label));
    const requestKey = request.headers['idempotency-key'];
    if (requestKey !== undefined && !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) invalid('Invalid payment request identifier.');
    if (route === 'payments' && requestKey === undefined) invalid('A payment request identifier is required.');
    const result = mutate(route,input,actor,requestKey);
    reply(response,result.replayed ? 200 : 201,result);
  } catch (error) {
    if (!error.status) console.error(JSON.stringify({ event:'request_error', code:error.code || 'UNEXPECTED' }));
    reply(response, error.status || 500, { error: error.status ? error.message : 'Local server error.' });
  }
}).listen(port, '127.0.0.1', () => console.log('MMS running at ' + address));
