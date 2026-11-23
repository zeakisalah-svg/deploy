const view = document.querySelector('#view');
const status = document.querySelector('#status');
const account = document.querySelector('#account');
const logout = document.querySelector('#logout');
let user;
let demo = false;
const navigation = document.querySelector('#navigation');
const money = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
const fmt = cents => money.format(cents / 100);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const date = value => new Date(value).toLocaleDateString('en', { timeZone: 'UTC', dateStyle: 'medium' });
const dateKey = value => new Intl.DateTimeFormat('sv-SE').format(value);
const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
const headings = {
  dashboard: ['Revenue overview', 'Monitor collections, assessments and outstanding balances.'],
  revenue: ['Assessments & billing', 'Issue assessments and review balances by bill.'],
  taxpayers: ['Taxpayer registry', 'Register and find synthetic taxpayers.'],
  payments: ['Payments & receipts', 'Record demo payments and open receipts.'],
  debts: ['Outstanding debts', 'Review unpaid bills and identify overdue accounts.'],
  reports: ['Revenue reports', 'Review totals and export the bill register.'],
  access: ['Roles & audit', 'Manage local access and review recorded activity.']
};
let state;

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.requestKey) headers['Idempotency-Key'] = options.requestKey;
  const response = await fetch('/api/v1/' + path, { ...options, headers });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') setUser(null);
    throw new Error(result.error);
  }
  return result;
}
function table(headers, rows, empty) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${headers.length}">${empty}</td></tr>`}</tbody></table></div>`;
}
function card(title, content) {
  return `<section class="panel"><h2>${title}</h2>${content}</section>`;
}
function taxpayer(id) {
  return state.taxpayers.find(record => record.id === id)?.name || 'Unknown';
}
function billStatus(bill) {
  if (!bill.balance) return 'Paid';
  return bill.due < dateKey(new Date()) ? 'Overdue' : 'Open';
}
function billTable(bills) {
  return table(['Bill', 'Taxpayer', 'Assessment', 'Due date', 'Billed', 'Outstanding', 'Status'], bills.map(bill => [
    'B-' + bill.id, escape(taxpayer(bill.taxpayer)), escape(bill.description), date(bill.due), fmt(bill.amount), fmt(bill.balance),
    `<span class="badge ${billStatus(bill).toLowerCase()}">${billStatus(bill)}</span>`
  ]), 'No bills to display.');
}
function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}
function totals() {
  return `<div class="metrics">${metric('Assessed',fmt(sum(state.bills,'amount')))}${metric('Net collected',fmt(sum(state.payments.filter(payment => !payment.reversed_at),'amount')))}${metric('Outstanding',fmt(sum(state.bills,'balance')))}${metric('Taxpayers',state.taxpayers.length)}</div>`;
}
function chart() {
  const today = new Date();
  const months = Array.from({length: 6}, (_, index) => {
    const month = new Date(today.getFullYear(), today.getMonth() + index - 5, 1);
    const key = dateKey(month).slice(0,7);
    return {
      label: month.toLocaleDateString('en', { month: 'short' }),
      total: sum(state.payments.filter(payment => dateKey(new Date(payment.date)).startsWith(key)), 'amount')
    };
  });
  const peak = Math.max(1, ...months.map(month => month.total));
  return `<div class="chart">${months.map(month => `<div class="month"><strong>${fmt(month.total)}</strong><meter min="0" max="${peak}" value="${month.total}" aria-label="${month.label} collections"></meter><span>${month.label}</span></div>`).join('')}</div>`;
}
function ledgerTable() {
  return table(['Entry','Source','Posted','Debit','Credit','Amount'],state.ledger.map(row => [
    row.id, ({ billed:'B-', paid:'R-', reversed:'RV-' })[row.kind] + row.source, row.posted_at ? date(row.posted_at) : 'Legacy · date unavailable',
    escape(row.debit),escape(row.credit),fmt(row.amount)
  ]),'No ledger entries.');
}
function dailyCollections() {
  const days = new Map();
  for (const payment of state.payments) {
    const day = dateKey(new Date(payment.date));
    const totals = days.get(day) || { count:0, amount:0, reversed:0 };
    days.set(day,{...totals,count:totals.count+1,amount:totals.amount+payment.amount});
    if (payment.reversed_at) {
      const reversalDay = dateKey(new Date(payment.reversed_at));
      const reversalTotals = days.get(reversalDay) || { count:0, amount:0, reversed:0 };
      days.set(reversalDay,{...reversalTotals,reversed:reversalTotals.reversed+payment.amount});
    }
  }
  return table(['Day','Receipts','Gross','Reversed','Net'], [...days].sort(([left],[right]) => right.localeCompare(left))
    .map(([day,totals]) => [date(day),totals.count,fmt(totals.amount),fmt(totals.reversed),fmt(totals.amount-totals.reversed)]),'No collections.');
}
function options(records, getLabel) {
  return '<option value="">Select…</option>' + records.map(record => `<option value="${record.id}">${escape(getLabel(record))}</option>`).join('');
}
function form(resource, fields, button) {
  return `<form data-resource="${resource}">${fields}<button type="submit">${button}</button></form>`;
}
const amountField = '<label>Amount (USD)<input name="amount" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" required></label>';
function reversalPanel(admin) {
  if (user?.role === 'viewer') return '';
  const requested = new Set(state.reversals.map(item => item.payment_id));
  const eligible = state.payments.filter(payment => !requested.has(payment.id));
  const pending = state.reversals.filter(item => !item.approved_at && item.requester_id !== user.id);
  const requestForm = eligible.length ? form('reversals',
    `<label>Receipt<select name="id" required>${options(eligible,payment=>'R-'+payment.id+' · '+fmt(payment.amount))}</select></label>` +
    '<label>Reason<input name="reason" maxlength="120" required></label>', 'Request reversal') : '';
  const approvalForm = admin && pending.length ? form('approve-reversal',
    `<label>Pending reversal<select name="id" required>${options(pending,item=>'RV-'+item.id+' · R-'+item.payment_id)}</select></label>`,
    'Approve reversal') : '';
  return card('Payment reversals', requestForm + approvalForm + table(['Reversal','Receipt','Reason','Status'],
    state.reversals.map(item=>['RV-'+item.id,'R-'+item.payment_id,escape(item.reason),item.approved_at ? 'Approved' : 'Pending approval']),
    'No reversal requests.'));
}
function receipts() {
  return table(['Receipt', 'Bill', 'Taxpayer', 'Date', 'Amount', 'Status'], state.payments.map(payment => [
    `<a class="receipt-link" href="#payments/${payment.id}">R-${payment.id}</a>`,
    'B-' + payment.bill, escape(taxpayer(state.bills.find(bill => bill.id === payment.bill)?.taxpayer)),
    date(payment.date), fmt(payment.amount), payment.reversed_at ? 'Reversed' : 'Recorded'
  ]), 'No payments recorded.');
}
function receipt(id) {
  const payment = state.payments.find(item => item.id === Number(id));
  if (!payment) return '<p>Receipt unavailable.</p>';
  const bill = state.bills.find(item => item.id === payment.bill);
  return card('Receipt R-' + payment.id, `<div class="receipt"><p>Receipt · ${date(payment.date)}</p>${payment.reversed_at ? `<p>Reversed on ${date(payment.reversed_at)}</p>` : ''}<p>${escape(taxpayer(bill.taxpayer))}</p><p>Bill B-${bill.id} · ${escape(bill.description)}</p><strong>${fmt(payment.amount)}</strong><div class="actions"><a href="#payments">Back to payments</a><button type="button" data-action="print">Print receipt</button></div></div>`);
}
function body(page, detail) {
  const admin = user?.role === 'admin';
  switch (page) {
    case 'dashboard':
      return totals() + card('Gross collections by month', chart()) + card('Recent bills', billTable(state.bills.slice(0,5)));
    case 'revenue':
      return (admin ? card('Issue a bill', form('bills', `<label>Taxpayer<select name="taxpayer" required>${options(state.taxpayers, item => item.name)}</select></label><label>Assessment<input name="description" maxlength="120" required></label>${amountField}<label>Due date<input name="due" type="date" required></label>`, 'Issue bill')) : '') + card('Bill register', billTable(state.bills));
    case 'taxpayers':
      if (detail) return taxpayerStatement(detail);
      return (admin ? card('Register a taxpayer', form('taxpayers', '<label>Name<input name="name" maxlength="120" required></label><label>Category<select name="category"><option>Business</option><option>Property</option><option>Individual</option></select></label>', 'Register taxpayer')) : '') +
        card('Registered taxpayers', '<label class="search">Search by name or category<input id="taxpayer-search" type="search"></label><div id="taxpayer-results"></div>');
    case 'payments': {
      if (detail) return receipt(detail);
      const open = state.bills.filter(bill => bill.balance);
      const paymentsForm = open.length ? form('payments', `<label>Bill<select name="bill" required>${options(open, bill => 'B-' + bill.id + ' · ' + taxpayer(bill.taxpayer) + ' · ' + fmt(bill.balance))}</select></label>${amountField}`, 'Record payment') : '<p>No bills have an outstanding balance.</p>';
      return (user?.role !== 'viewer' ? card('Record a payment', paymentsForm) : '') + card('Receipt register', receipts()) + reversalPanel(admin);
    }
    case 'debts': {
      const unpaid = state.bills.filter(bill => bill.balance);
      const overdue = unpaid.filter(bill => billStatus(bill) === 'Overdue');
      return `<div class="metrics debts">${metric('Overdue',fmt(sum(overdue,'balance')))}${metric('Total outstanding',fmt(sum(unpaid,'balance')))}</div>` + card('Debt aging', debtAging(unpaid)) + card('Unpaid bills', billTable(unpaid));
    }
    case 'reports':
      return totals() + (admin ? card('Revenue ledger · latest 100 entries', ledgerTable()) : '') + card('Daily collections', dailyCollections()) + card('Bill register export', '<button type="button" data-action="export">Download bills CSV</button>') + card('Gross collections by month', chart());
    case 'access':
      const staffForm = form('accounts', '<label>Account name<input name="username" maxlength="40" autocomplete="off" required></label><label>Temporary password<input name="password" type="password" minlength="15" maxlength="128" autocomplete="new-password" required></label><label>Assigned role<select name="role"><option value="viewer">Viewer</option><option value="cashier">Cashier</option><option value="admin">Administrator</option></select></label>', 'Create account');
      return (admin ? card('Create staff account', staffForm) : '') + card('Account permissions', table(['Role','Allowed actions'], [
        ['Administrator','Read records, register taxpayers, issue bills, record payments, request and approve reversals, view audit and create staff accounts'],
        ['Cashier','Read records, record payments and request reversals'],
        ['Viewer','Read records']
      ], '')) + card('Activity log', admin ? table(['Date (UTC)','Role','Event'], state.audit.map(entry => [escape(entry.date),escape(entry.role + (entry.actor_id ? ' #' + entry.actor_id : '')),escape(entry.action)]), 'No activity.') : '<p>Administrator access is required to view the audit log.</p>');
  }
}
function taxpayerStatement(id) {
  const record = state.taxpayers.find(item => item.id === Number(id));
  if (!record) return '<p>Taxpayer unavailable.</p>';
  const bills = state.bills.filter(item => item.taxpayer === record.id);
  const billIds = new Set(bills.map(item => item.id));
  const payments = state.payments.filter(item => billIds.has(item.bill));
  return card('Statement T-' + record.id, '<p>' + escape(record.name) + ' · ' + escape(record.category) + '</p>' +
    '<p>Outstanding ' + fmt(sum(bills,'balance')) + '</p><div class="actions"><a href="#taxpayers">Back to registry</a><button type="button" data-action="print">Print statement</button></div>') +
    card('Assessment history',billTable(bills)) +
    card('Payment history', table(['Receipt','Date','Amount','Status'],payments.map(item=>[
      'R-' + item.id,date(item.date),fmt(item.amount),item.reversed_at ? 'Reversed' : 'Recorded'
    ]),'No payments recorded.'));
}
function debtAging(bills) {
  const today = new Date(dateKey(new Date()));
  const groups = { 'Not overdue':0, '1–30 days':0, '31–60 days':0, '61–90 days':0, '91+ days':0 };
  for (const bill of bills) {
    const age = (today-new Date(bill.due))/86_400_000;
    const bucket = age <= 0 ? 'Not overdue' : age <= 30 ? '1–30 days' : age <= 60 ? '31–60 days' : age <= 90 ? '61–90 days' : '91+ days';
    groups[bucket] += bill.balance;
  }
  return table(['Time overdue','Balance'],Object.entries(groups).map(([label,value])=>[label,fmt(value)]),'No outstanding balances.');
}
function renderTaxpayers(query = '') {
  const results = document.querySelector('#taxpayer-results');
  if (!results) return;
  const term = query.trim().toLowerCase();
  const records = state.taxpayers.filter(record => (record.name + ' ' + record.category).toLowerCase().includes(term));
  results.innerHTML = table(['Reference','Name','Category'], records.map(record => [
    `<a href="#taxpayers/${record.id}">T-${record.id}</a>`, escape(record.name), escape(record.category)
  ]), 'No matching taxpayers.');
}
function render() {
  if (!state) return;
  const [hash, detail] = location.hash.slice(1).split('/');
  const page = Object.hasOwn(headings, hash) ? hash : 'dashboard';
  for (const link of navigation.querySelectorAll('a')) {
    if (link.hash === '#' + page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const [title, subtitle] = headings[page];
  view.innerHTML = `<div class="page"><div class="intro"><h1>${title}</h1><p>${subtitle}</p></div>${body(page, detail)}</div>`;
  renderTaxpayers();
}
async function load() {
  const selected = user;
  const data = await api('state');
  if (selected !== user) return;
  state = data;
  render();
}
function showError(error) {
  status.textContent = error.message;
  status.className = 'error';
}
function setUser(next) {
  user = next;
  navigation.hidden = !user;
  logout.hidden = !user;
  account.textContent = user ? user.username + ' · ' + user.role : '';
  state = undefined;
  if (user) {
    view.textContent = 'Loading…';
    return;
  }
  const demoText = demo ? '<p>Synthetic demo accounts are admin, cashier, and viewer. Password: <code>mms-synthetic-example</code>.</p>' : '';
  view.innerHTML = '<div class="intro"><h1>Sign in to MMS</h1></div>' +
    card('Staff account', demoText + '<form id="signin"><label>Account name<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>');
}
logout.addEventListener('click', async () => {
  try {
    await api('logout', { method:'POST', body:'{}' });
    status.textContent = '';
    setUser(null);
  } catch (error) { showError(error); }
});
window.addEventListener('hashchange', () => {
  status.textContent = '';
  render();
});
view.addEventListener('input', event => {
  if (event.target.id === 'taxpayer-search') renderTaxpayers(event.target.value);
});
view.addEventListener('submit', async event => {
  const form = event.target;
  event.preventDefault();
  const button = form.querySelector('button');
  const input = Object.fromEntries(new FormData(form));
  if (form.id === 'signin') {
    button.disabled = true;
    try {
      setUser(await api('login', { method:'POST', body:JSON.stringify(input) }));
      status.textContent = '';
      await load();
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
    return;
  }
  for (const field of ['bill', 'taxpayer', 'id']) {
    if (field in input) input[field] = Number(input[field]);
  }
  if ('amount' in input) {
    const [whole, fraction = ''] = input.amount.split('.');
    input.amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }
  const body = JSON.stringify(input);
  if (form.dataset.resource === 'payments' && form.dataset.paymentBody !== body) {
    form.dataset.paymentKey = crypto.randomUUID();
    form.dataset.paymentBody = body;
  }
  button.disabled = true;
  try {
    const result = await api(form.dataset.resource, { method:'POST', body, requestKey:form.dataset.paymentKey });
    form.reset();
    status.className = '';
    status.textContent = result.action + (result.id ? ' #' + result.id : '');
    await load();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});
function csvCell(value) {
  const text = String(value);
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}
view.addEventListener('click', event => {
  if (event.target.dataset.action === 'print') window.print();
  if (event.target.dataset.action !== 'export') return;
  const rows = [['Bill','Taxpayer','Assessment','Due date','Billed USD','Outstanding USD','Status']];
  for (const bill of state.bills) {
    rows.push(['B-' + bill.id, taxpayer(bill.taxpayer), bill.description, bill.due, (bill.amount / 100).toFixed(2), (bill.balance / 100).toFixed(2), billStatus(bill)]);
  }
  const url = URL.createObjectURL(new Blob([rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mms-demo-bills.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
api('session').then(async result => {
  demo = result.demo;
  setUser(result.user);
  if (user) await load();
}).catch(showError);
