const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.MMS_DB || join(__dirname, 'mms-demo.sqlite'));
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

const permissions = {
  admin: ['taxpayers', 'bills', 'payments', 'audit'],
  cashier: ['payments'],
  viewer: []
};
const files = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript']
};
function snapshot(role) {
  return {
    taxpayers: db.prepare('SELECT * FROM taxpayers ORDER BY id DESC').all(),
    bills: db.prepare(`SELECT bills.*, amount - COALESCE((SELECT SUM(payments.amount) FROM payments WHERE bill = bills.id),0) AS balance FROM bills ORDER BY id DESC`).all(),
    payments: db.prepare('SELECT * FROM payments ORDER BY id DESC').all(),
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
function mutate(resource, input, role) {
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
      action = 'Issued assessment and bill';
    } else {
      const bill = integer(input.bill);
      const amount = integer(input.amount);
      const record = db.prepare('SELECT amount - COALESCE((SELECT SUM(amount) FROM payments WHERE bill = bills.id),0) AS balance FROM bills WHERE id = ?').get(bill);
      if (!record || amount > record.balance) invalid('Payment exceeds the outstanding balance or the bill does not exist.');
      id = db.prepare('INSERT INTO payments (bill, amount, date) VALUES (?,?,?)').run(bill, amount, now).lastInsertRowid;
      action = 'Recorded payment and issued receipt';
    }
    db.prepare('INSERT INTO audit (date, role, action) VALUES (?,?,?)').run(now, role, action + ' #' + id);
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
createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (request.method === 'GET' && Object.hasOwn(files, request.url)) {
      const [file, type] = files[request.url];
      const body = readFileSync(join(__dirname, file));
      response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(body);
    }
    const role = request.headers['x-demo-role'];
    if (!Object.hasOwn(permissions, role)) return reply(response, 403, { error: 'Select a demo role.' });
    if (request.method === 'GET' && request.url === '/api/state') return reply(response, 200, snapshot(role));
    const resource = request.url.slice(5);
    if (request.method !== 'POST' || !['/api/taxpayers', '/api/bills', '/api/payments'].includes(request.url)) return reply(response, 404, { error: 'Route not found.' });
    if (!permissions[role].includes(resource)) return reply(response, 403, { error: 'This demo role does not have permission.' });
    if (request.headers.host !== '127.0.0.1:' + port || (request.headers.origin && request.headers.origin !== address)) return reply(response, 403, { error: 'Use the local MMS address.' });
    if (request.headers['content-type'] !== 'application/json') return reply(response, 415, { error: 'Expected JSON.' });
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 8192) return reply(response, 413, { error: 'Request is too large.' });
    }
    let input;
    try { input = JSON.parse(body); } catch { invalid('Invalid JSON.'); }
    reply(response, 201, mutate(resource, input, role));
  } catch (error) {
    if (!error.status) console.error(error);
    reply(response, error.status || 500, { error: error.status ? error.message : 'Local server error.' });
  }
}).listen(port, '127.0.0.1', () => console.log('MMS demo running at ' + address));

