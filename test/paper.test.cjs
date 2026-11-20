'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const requireFromTest = createRequire(__filename);

async function paperModule() {
  return import('../public/paper.mjs');
}

test('new paper account starts with virtual INR cash only', async () => {
  const { emptyPaperAccount } = await paperModule();
  assert.deepEqual(emptyPaperAccount(), { cash: 500000, positions: {}, orders: [], trades: [], realizedPnl: 0 });
});

test('market buy fills at live quote and updates only paper ledger', async () => {
  const { emptyPaperAccount, markOrderFromQuote } = await paperModule();
  const result = markOrderFromQuote(emptyPaperAccount(), { symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 3 }, { last: 1500, receivedAt: 10 }, 10);
  assert.equal(result.filled, true);
  assert.equal(result.order.fillPrice, 1500);
  assert.equal(result.account.cash, 495500);
  assert.deepEqual(result.account.positions.INFY, { quantity: 3, averagePrice: 1500 });
  assert.equal(result.account.trades.length, 1);
});

test('paper orders reject stale prices, bad quantities, insufficient cash, and short sells', async () => {
  const { emptyPaperAccount, markOrderFromQuote } = await paperModule();
  assert.throws(() => markOrderFromQuote(emptyPaperAccount(), { symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 1 }, null), /fresh live price/);
  assert.throws(() => markOrderFromQuote(emptyPaperAccount(), { symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 0 }, { last: 1500, receivedAt: Date.now() }), /positive whole number/);
  assert.throws(() => markOrderFromQuote(emptyPaperAccount(), { symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 2 }, { last: 300000, receivedAt: Date.now() }), /Not enough paper cash/);
  assert.throws(() => markOrderFromQuote(emptyPaperAccount(), { symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 1 }, { last: 1500, receivedAt: Date.now() }), /does not hold enough shares/);
  assert.throws(() => markOrderFromQuote(emptyPaperAccount(), { symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 1 }, { last: 1500, receivedAt: 1 }, 20000), /quote is stale/);
});

test('limit order waits locally, then fills only after the quote crosses', async () => {
  const { emptyPaperAccount, markOrderFromQuote, processPaperLimits } = await paperModule();
  const waiting = markOrderFromQuote(emptyPaperAccount(), { symbol: 'TCS', side: 'BUY', type: 'LIMIT', quantity: 2, limitPrice: 3500 }, { last: 3800, receivedAt: 10 }, 10);
  assert.equal(waiting.filled, false);
  assert.equal(waiting.account.orders[0].status, 'PENDING');
  const noFill = processPaperLimits(waiting.account, 'TCS', 3550, 11);
  assert.equal(noFill.filled.length, 0);
  const fill = processPaperLimits(noFill.account, 'TCS', 3490, 12);
  assert.equal(fill.filled.length, 1);
  assert.equal(fill.filled[0].fillPrice, 3490);
  assert.equal(fill.account.cash, 493020);
});

test('sell fills realize paper P&L and cannot overdraw position quantity', async () => {
  const { emptyPaperAccount, markOrderFromQuote } = await paperModule();
  let account = markOrderFromQuote(emptyPaperAccount(), { symbol: 'ITC', side: 'BUY', type: 'MARKET', quantity: 10 }, { last: 400, receivedAt: 1 }, 1).account;
  const sale = markOrderFromQuote(account, { symbol: 'ITC', side: 'SELL', type: 'MARKET', quantity: 4 }, { last: 450, receivedAt: 2 }, 2);
  assert.equal(sale.account.cash, 497800);
  assert.equal(sale.account.positions.ITC.quantity, 6);
  assert.equal(sale.account.realizedPnl, 200);
});

test('paper account serialization restores browser-local values safely', async () => {
  const { emptyPaperAccount, savePaperAccount, readPaperAccount } = await paperModule();
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const account = { ...emptyPaperAccount(), cash: 1234 };
  savePaperAccount(storage, account);
  assert.equal(readPaperAccount(storage).cash, 1234);
  values.set('northstar-paper-v2', '{bad json');
  assert.equal(readPaperAccount(storage).cash, 500000);
});

test('quote binary parser handles live equity and index packet layouts', () => {
  const { parseKiteBinary } = requireFromTest('../server.js');
  const tokenMap = new Map([[1001, { symbol: 'INFY', exchange: 'NSE', kind: 'equity' }], [2001, { symbol: 'NIFTY 50', exchange: 'NSE', kind: 'index' }]]);
  const equity = Buffer.alloc(44); equity.writeUInt32BE(1001, 0); equity.writeInt32BE(12345, 4); equity.writeUInt32BE(9876, 16); equity.writeInt32BE(12000, 28); equity.writeInt32BE(12500, 32); equity.writeInt32BE(11900, 36); equity.writeInt32BE(12000, 40);
  const index = Buffer.alloc(28); index.writeUInt32BE(2001, 0); index.writeInt32BE(2300050, 4); index.writeInt32BE(2310000, 8); index.writeInt32BE(2290000, 12); index.writeInt32BE(2280000, 16); index.writeInt32BE(2290000, 20);
  const frame = Buffer.alloc(2 + 2 + equity.length + 2 + index.length); frame.writeUInt16BE(2, 0); frame.writeUInt16BE(equity.length, 2); equity.copy(frame, 4); const second = 4 + equity.length; frame.writeUInt16BE(index.length, second); index.copy(frame, second + 2);
  const updates = parseKiteBinary(frame, tokenMap, 99);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].last, 123.45);
  assert.equal(updates[0].volume, 9876);
  assert.equal(updates[1].last, 23000.5);
  assert.equal(updates[1].changePct, (100.5 / 22900) * 100);
});

test('instrument CSV maps exchange symbols and preserves quoted commas', () => {
  const { parseInstrumentCsv } = requireFromTest('../server.js');
  const csv = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n1001,2,RELIANCE,"Reliance, Industries",0,,,0.05,1,EQ,NSE-EQ,NSE\n';
  const items = parseInstrumentCsv(csv);
  assert.equal(items.get('RELIANCE').token, 1001);
});

test('server exposes live-data setup but no real-order API', async () => {
  const { createMarketServer } = requireFromTest('../server.js');
  const app = createMarketServer({ env: {} });
  const handler = app.server.listeners('request')[0];
  async function request(method, url) {
    const req = { method, url, socket: { remoteAddress: '127.0.0.1' }, on() {} };
    const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); }, end(body = '') { this.body = String(body); } };
    await handler(req, res);
    return res;
  }
  const statusResponse = await request('GET', '/api/status');
  const status = JSON.parse(statusResponse.body);
  assert.equal(status.configured, false);
  assert.equal(status.feedState, 'not-configured');
  const market = JSON.parse((await request('GET', '/api/market')).body);
  assert.deepEqual(market.quotes, {});
  assert.equal((await request('GET', '/auth/kite')).statusCode, 503);
  assert.equal((await request('GET', '/api/history?symbol=RELIANCE')).statusCode, 401);
  assert.equal((await request('GET', '/api/orders')).statusCode, 404);
  assert.equal((await request('POST', '/api/orders')).statusCode, 405);
  const page = (await request('GET', '/')).body;
  assert.match(page, /PAPER MODE · NO REAL ORDERS/);
  assert.match((await request('GET', '/paper.mjs')).body, /markOrderFromQuote/);
});

test('Kite login setup never returns the API secret to the browser', async () => {
  const { createMarketServer } = requireFromTest('../server.js');
  const app = createMarketServer({ env: { KITE_API_KEY: 'public-key', KITE_API_SECRET: 'private-secret' } });
  const handler = app.server.listeners('request')[0];
  const req = { method: 'GET', url: '/auth/kite', socket: { remoteAddress: '127.0.0.1' }, on() {} };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); }, end(body = '') { this.body = String(body); } };
  await handler(req, res);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /api_key=public-key/);
  assert.doesNotMatch(res.headers.Location, /private-secret/);
  assert.equal(app.status().secret, undefined);
});

test('server rejects non-loopback requests', async () => {
  const { createMarketServer } = requireFromTest('../server.js');
  const app = createMarketServer({ env: {} });
  const handler = app.server.listeners('request')[0];
  const req = { method: 'GET', url: '/api/status', socket: { remoteAddress: '10.0.0.8' }, on() {} };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); }, end(body = '') { this.body = String(body); } };
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('Kite callback exchanges a one-time token without exposing the access token', async () => {
  const crypto = require('node:crypto');
  const { createMarketServer } = requireFromTest('../server.js');
  let request;
  const app = createMarketServer({
    env: { KITE_API_KEY: 'public-key', KITE_API_SECRET: 'private-secret' },
    autoConnect: false,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ status: 'success', data: { access_token: 'access-secret', user_shortname: 'Alex' } }) };
    }
  });
  const handler = app.server.listeners('request')[0];
  const req = { method: 'GET', url: '/kite/callback?request_token=once-only&status=success', socket: { remoteAddress: '127.0.0.1' }, on() {} };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); }, end(body = '') { this.body = String(body); } };
  await handler(req, res);
  const checksum = crypto.createHash('sha256').update('public-keyonce-onlyprivate-secret').digest('hex');
  assert.equal(request.url, 'https://api.kite.trade/session/token');
  assert.equal(new URLSearchParams(request.options.body).get('checksum'), checksum);
  assert.equal(new URLSearchParams(request.options.body).get('request_token'), 'once-only');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/');
  assert.equal(app.status().authenticated, true);
  assert.equal(JSON.stringify(app.status()).includes('access-secret'), false);
  assert.equal(JSON.stringify(app.snapshot()).includes('access-secret'), false);
});
