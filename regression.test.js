const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readdirSync, unlinkSync, rmdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { verifyAudit } = require('./identity');

test('local authentication, revenue and database recovery', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mms-tests-'));
  const database = join(dir,'test.sqlite');
  const env = { ...process.env, MMS_PORT:'18765', MMS_DB:database, MMS_PASSWORD:'temporary-test-passphrase' };
  try {
    for (const role of ['admin','cashier','viewer']) {
      const created = require('node:child_process').spawnSync(process.execPath,['server.js','--create-account'],{
        env:{...env,MMS_ROLE:role,MMS_ACCOUNT:role}, encoding:'utf8'
      });
      assert.equal(created.status,0,created.stderr);
    }
    const server = spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','inherit']});
    const stopped = new Promise(resolve => server.once('close',resolve));
    try {
      await new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('Test server did not start')),5000);
        server.once('error',reject);
        server.once('exit',code => {clearTimeout(timer); reject(new Error('Test server exited with '+code));});
        server.stdout.once('data',() => {clearTimeout(timer); resolve();});
      });
      const base = 'http://127.0.0.1:18765';
      for (const path of ['/','/style.css','/app.js']) assert.equal((await fetch(base+path)).status,200);
      async function call(path,{ body, cookie, headers = {} } = {}) {
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (cookie) headers.Cookie = cookie;
        const response = await fetch(base+'/api/v1/'+path,{
          headers, method:body !== undefined ? 'POST' : 'GET', body:JSON.stringify(body)
        });
        return {status:response.status, data:await response.json(), cookie:response.headers.get('set-cookie')};
      }
      assert.equal((await call('state',{headers:{'X-Demo-Role':'admin'}})).status,401);
      assert.equal((await call('login',{body:{username:'admin',password:'wrong'}})).status,401);
      assert.equal((await call('login',{body:{},headers:{Origin:'https://example.invalid'}})).status,403);
      async function signIn(role) {
        const result = await call('login',{body:{username:role,password:env.MMS_PASSWORD}});
        assert.equal(result.status,200);
        assert.equal(result.data.role,role);
        assert.match(result.cookie,/HttpOnly; SameSite=Strict/);
        return result.cookie.split(';')[0];
      }
      const admin = await signIn('admin');
      const cashier = await signIn('cashier');
      const viewer = await signIn('viewer');
      const registered = await call('taxpayers',{cookie:admin,body:{name:'Synthetic Co.',category:'Business'}});
      assert.equal(registered.status,201);
      assert.equal((await call('accounts',{cookie:cashier,body:{}})).status,403);
      assert.equal((await call('taxpayers',{cookie:viewer,body:{},headers:{'X-Demo-Role':'admin'}})).status,403);
      const issue = {taxpayer:registered.data.id,amount:101,description:'Synthetic assessment'};
      assert.equal((await call('bills',{cookie:admin,body:{...issue,due:'2026-02-31'}})).status,400);
      const bill = await call('bills',{cookie:admin,body:{...issue,due:'2026-12-20'}});
      assert.equal(bill.status,201);
      const pay = (amount,key = randomUUID()) => call('payments',{cookie:cashier,body:{bill:bill.data.id,amount},headers:key ? {'Idempotency-Key':key} : {}});
      assert.equal((await pay(102)).status,400);
      const round = await Promise.all([pay(75),pay(75)]);
      assert.deepEqual(round.map(result => result.status).sort(),[201,400]);
      const key = randomUUID();
      const first = await pay(26,key);
      assert.equal(first.status,201);
      const retry = await pay(26,key);
      assert.equal(retry.status,200);
      assert.equal(retry.data.id,first.data.id);
      assert.equal((await pay(25,key)).status,409);
      const state = (await call('state',{cookie:admin})).data;
      assert.equal(state.bills.find(row=>row.id===bill.data.id).balance,0);
      assert.equal(state.payments.filter(row=>row.bill===bill.data.id).length,2);
      assert.equal(state.ledger.filter(row=>row.kind==='paid').length,4);
      assert.ok(state.ledger.every(row=>row.debit!==row.credit && Number.isInteger(row.amount)));
      assert.ok(state.audit.some(entry=>entry.action.startsWith('Recorded payment') && entry.actor_id));
      const request = (paymentId,cookie) => call('reversals',{cookie,body:{id:paymentId,reason:'Duplicate entry'}});
      const approve = (id,cookie) => call('approve-reversal',{cookie,body:{id}});
      const own = await request(state.payments.find(row=>row.bill===bill.data.id && row.amount===75).id,admin);
      assert.equal(own.status,201);
      assert.equal((await approve(own.data.id,admin)).status,409);
      const other = await request(first.data.id,cashier);
      assert.equal(other.status,201);
      assert.equal((await request(first.data.id,cashier)).status,409);
      assert.equal((await approve(other.data.id,cashier)).status,403);
      assert.equal((await approve(other.data.id,admin)).status,201);
      assert.equal((await approve(other.data.id,admin)).status,409);
      const reopened=(await call('state',{cookie:admin})).data;
      assert.equal(reopened.bills.find(row=>row.id===bill.data.id).balance,26);
      assert.ok(reopened.payments.find(row=>row.id===first.data.id).reversed_at);
      assert.ok(reopened.ledger.some(row=>row.kind==='reversed' && row.amount===26 && row.debit==='Receivables' && row.credit==='Cash'));
      assert.equal((await pay(27)).status,400);
      assert.equal((await pay(26)).status,201);
      assert.equal((await call('state',{cookie:viewer})).data.audit.length,0);
      assert.equal((await call('logout',{cookie:viewer,body:{}})).status,200);
      assert.equal((await call('state',{cookie:viewer})).status,401);
    } finally {
      server.kill();
      await stopped;
    }
    const source = new DatabaseSync(database);
    const recoveredFile = join(dir,'recovered.sqlite');
    try {
      await backup(source,recoveredFile);
      const restored = new DatabaseSync(recoveredFile);
      try {
        assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
        assert.deepEqual(restored.prepare('SELECT * FROM payments').all(),source.prepare('SELECT * FROM payments').all());
        assert.equal(verifyAudit(restored),true);
        restored.prepare("UPDATE audit SET action='changed' WHERE id=1").run();
        assert.equal(verifyAudit(restored),false);
      } finally { restored.close(); }
    } finally { source.close(); }
  } finally {
    for (const file of readdirSync(dir)) unlinkSync(join(dir,file));
    rmdirSync(dir);
  }
});
