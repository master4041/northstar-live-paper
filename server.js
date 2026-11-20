'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const EQUITIES = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'ITC', 'SUNPHARMA', 'TATAMOTORS'];
const INDEXES = ['NIFTY 50', 'SENSEX', 'NIFTY BANK'];
const ALLOWED = new Set([...EQUITIES, ...INDEXES]);

function loadEnvFile(file = path.join(ROOT, '.env'), target = process.env) {
  if (!fs.existsSync(file)) return;
  for (const row of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = row.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && target[match[1]] == null) target[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function parseCsvRow(line) {
  const values = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { values.push(value); value = ''; }
    else value += char;
  }
  values.push(value);
  return values;
}

function parseInstrumentCsv(text) {
  const rows = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvRow(rows.shift() || '');
  const index = Object.fromEntries(headers.map((key, i) => [key, i]));
  const found = new Map();
  for (const line of rows) {
    const row = parseCsvRow(line);
    const exchange = row[index.exchange];
    const symbol = row[index.tradingsymbol];
    const token = Number(row[index.instrument_token]);
    const segment = row[index.segment] || '';
    if (!Number.isFinite(token)) continue;
    if (exchange === 'NSE' && EQUITIES.includes(symbol)) found.set(symbol, { symbol, exchange, token, kind: 'equity', segment });
    if (exchange === 'NSE' && symbol === 'NIFTY 50') found.set('NIFTY 50', { symbol, exchange, token, kind: 'index', segment });
    if (exchange === 'BSE' && symbol === 'SENSEX') found.set('SENSEX', { symbol, exchange, token, kind: 'index', segment });
    if (exchange === 'NSE' && symbol === 'NIFTY BANK') found.set('NIFTY BANK', { symbol, exchange, token, kind: 'index', segment });
  }
  return found;
}

function parseKiteBinary(input, tokenLookup, receivedAt = Date.now()) {
  const data = Buffer.from(input);
  if (data.length < 2) return [];
  const packetCount = data.readUInt16BE(0);
  const updates = [];
  let offset = 2;
  for (let n = 0; n < packetCount; n++) {
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset); offset += 2;
    if (!length || offset + length > data.length) break;
    const packet = data.subarray(offset, offset + length); offset += length;
    if (packet.length < 8) continue;
    const token = packet.readUInt32BE(0);
    const instrument = tokenLookup.get(token);
    if (!instrument) continue;
    const rupees = (pos) => packet.readInt32BE(pos) / 100;
    let quote;
    if (instrument.kind === 'index' || packet.length === 28 || packet.length === 32) {
      if (packet.length < 28) continue;
      const last = rupees(4), close = rupees(20);
      quote = { symbol: instrument.symbol, exchange: instrument.exchange, kind: 'index', last, open: rupees(16), high: rupees(8), low: rupees(12), previousClose: close, volume: null };
    } else {
      if (packet.length < 44) continue;
      const last = rupees(4), close = rupees(40);
      quote = { symbol: instrument.symbol, exchange: instrument.exchange, kind: 'equity', last, open: rupees(28), high: rupees(32), low: rupees(36), previousClose: close, volume: packet.readUInt32BE(16) };
    }
    quote.change = quote.previousClose ? quote.last - quote.previousClose : 0;
    quote.changePct = quote.previousClose ? quote.change / quote.previousClose * 100 : 0;
    quote.receivedAt = receivedAt;
    updates.push(quote);
  }
  return updates;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function createMarketServer(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const autoConnect = options.autoConnect !== false;
  const apiKey = env.KITE_API_KEY || '';
  const apiSecret = env.KITE_API_SECRET || '';
  let accessToken = null;
  let userName = null;
  let feedState = apiKey && apiSecret ? 'disconnected' : 'not-configured';
  let feedMessage = apiKey && apiSecret ? 'Connect your Zerodha account to start live quotes.' : 'Add Kite Connect credentials to .env, then restart Northstar.';
  let socket = null;
  let retryTimer = null;
  let instrumentMap = new Map();
  let tokenLookup = new Map();
  const quotes = new Map();
  const clients = new Set();

  function status() {
    return { provider: 'Zerodha Kite Connect', configured: Boolean(apiKey && apiSecret), connected: Boolean(accessToken && feedState === 'live'), authenticated: Boolean(accessToken), feedState, feedMessage, receivedAt: Math.max(0, ...[...quotes.values()].map(q => q.receivedAt || 0)), symbols: [...quotes.keys()] };
  }

  function snapshot() { return { status: status(), quotes: Object.fromEntries(quotes) }; }
  function broadcast(event = 'snapshot', payload = snapshot()) {
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) { try { client.write(line); } catch { clients.delete(client); } }
  }
  function setFeed(state, message) { feedState = state; feedMessage = message; broadcast('status', status()); }

  async function loadInstruments() {
    const response = await fetchImpl('https://api.kite.trade/instruments', { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${accessToken}` } });
    if (!response.ok) throw new Error(`Kite instruments request failed (${response.status}).`);
    instrumentMap = parseInstrumentCsv(await response.text());
    tokenLookup = new Map([...instrumentMap.values()].map(item => [item.token, item]));
    const missing = EQUITIES.filter(symbol => !instrumentMap.has(symbol));
    if (missing.length) throw new Error(`Kite instrument list did not include: ${missing.join(', ')}.`);
    return [...instrumentMap.values()];
  }

  function scheduleReconnect() {
    if (!accessToken || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connectFeed().catch(err => setFeed('error', err.message)); }, 5000);
    retryTimer.unref?.();
  }

  async function connectFeed() {
    if (!accessToken) return;
    if (typeof WebSocketImpl !== 'function') { setFeed('error', 'This Node.js version does not provide WebSocket support. Use Node 22 or newer.'); return; }
    try {
      if (!instrumentMap.size) await loadInstruments();
      socket?.close();
      setFeed('connecting', 'Opening the Kite live market stream…');
      const url = `wss://ws.kite.trade?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(accessToken)}`;
      const activeSocket = new WebSocketImpl(url);
      socket = activeSocket;
      activeSocket.addEventListener('open', () => {
        if (socket !== activeSocket) return;
        const tokens = [...instrumentMap.values()].map(item => item.token);
        activeSocket.send(JSON.stringify({ a: 'subscribe', v: tokens }));
        activeSocket.send(JSON.stringify({ a: 'mode', v: ['quote', tokens] }));
        setFeed('live', 'Live quotes connected through Kite Connect.');
      });
      activeSocket.addEventListener('message', async event => {
        if (socket !== activeSocket) return;
        try {
          let data = event.data;
          if (typeof data === 'string') {
            const parsed = JSON.parse(data);
            if (parsed.type === 'error') setFeed('error', parsed.data || 'Kite stream reported an error.');
            return;
          }
          if (data instanceof Blob) data = await data.arrayBuffer();
          const updates = parseKiteBinary(data, tokenLookup);
          if (!updates.length) return;
          for (const quote of updates) quotes.set(quote.symbol, quote);
          broadcast('quotes', updates);
        } catch { setFeed('error', 'Received a quote message that could not be read.'); }
      });
      activeSocket.addEventListener('error', () => { if (socket === activeSocket) setFeed('error', 'Kite quote stream connection failed. Check login, network, and Kite status.'); });
      activeSocket.addEventListener('close', () => {
        if (socket === activeSocket && accessToken) { setFeed('disconnected', 'Kite quote stream closed. Reconnecting…'); scheduleReconnect(); }
      });
    } catch (error) {
      setFeed('error', error.message || 'Could not start the Kite quote stream.');
      scheduleReconnect();
    }
  }

  function stopFeed() {
    accessToken = null; userName = null; instrumentMap.clear(); tokenLookup.clear(); quotes.clear();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    try { socket?.close(); } catch {}
    socket = null;
    setFeed(apiKey && apiSecret ? 'disconnected' : 'not-configured', apiKey && apiSecret ? 'Disconnected from Kite.' : 'Add Kite Connect credentials to .env, then restart Northstar.');
  }

  function secureHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  }

  const server = http.createServer(async (req, res) => {
    secureHeaders(res);
    const remote = req.socket.remoteAddress || '';
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return json(res, 403, { error: 'Northstar only accepts local connections.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
      }
      if (req.method === 'GET' && url.pathname === '/paper.mjs') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(PUBLIC, 'paper.mjs')));
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
      if (req.method === 'GET' && url.pathname === '/api/market') return json(res, 200, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/auth/kite') {
        if (!apiKey || !apiSecret) return json(res, 503, { error: 'Configure KITE_API_KEY and KITE_API_SECRET in .env first.' });
        res.writeHead(302, { Location: `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}` });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/kite/callback') {
        if (url.searchParams.get('status') === 'error') { setFeed('error', 'Kite login was cancelled or rejected.'); res.writeHead(302, { Location: '/' }); return res.end(); }
        const requestToken = url.searchParams.get('request_token');
        if (!requestToken || requestToken.length > 512 || !apiKey || !apiSecret) { setFeed('error', 'Kite did not return a usable login token.'); res.writeHead(302, { Location: '/' }); return res.end(); }
        const checksum = crypto.createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');
        const body = new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum });
        const response = await fetchImpl('https://api.kite.trade/session/token', { method: 'POST', headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        const result = await response.json();
        if (!response.ok || result.status !== 'success' || !result.data?.access_token) throw new Error(result.message || 'Kite token exchange failed.');
        accessToken = result.data.access_token; userName = result.data.user_shortname || result.data.user_name || 'Kite user';
        setFeed('authenticated', `Signed in to Kite as ${userName}; starting live quotes…`);
        if (autoConnect) connectFeed().catch(err => setFeed('error', err.message));
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') { stopFeed(); res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const symbol = url.searchParams.get('symbol');
        if (!ALLOWED.has(symbol) || !EQUITIES.includes(symbol)) return json(res, 400, { error: 'Choose a supported equity symbol.' });
        const instrument = instrumentMap.get(symbol);
        if (!accessToken || !instrument) return json(res, 401, { error: 'Connect Kite before loading live history.' });
        const days = Math.min(365, Math.max(7, Number(url.searchParams.get('days')) || 45));
        const to = new Date(); const from = new Date(to.getTime() - days * 86400000);
        const date = d => d.toISOString().slice(0, 10);
        const endpoint = `https://api.kite.trade/instruments/historical/${instrument.token}/day?from=${date(from)}&to=${date(to)}`;
        const response = await fetchImpl(endpoint, { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${accessToken}` } });
        const data = await response.json();
        if (!response.ok || data.status !== 'success') return json(res, response.status || 502, { error: data.message || 'Kite history request failed.' });
        return json(res, 200, { symbol, candles: data.data.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API route not found.' });
      if (req.method === 'GET') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      return json(res, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (url.pathname === '/kite/callback') { setFeed('error', error.message || 'Kite login failed.'); res.writeHead(302, { Location: '/' }); return res.end(); }
      return json(res, 502, { error: error.message || 'Market data request failed.' });
    }
  });

  return { server, status, snapshot, connectFeed, stopFeed, parseInstrumentCsv, parseKiteBinary };
}

if (require.main === module) {
  loadEnvFile();
  const port = Number(process.env.PORT || 3000);
  const { server, status } = createMarketServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Northstar ready at http://127.0.0.1:${port}`);
    if (!status().configured) console.log('Kite Connect not configured. Copy .env.example to .env and add credentials.');
  });
}

module.exports = { createMarketServer, loadEnvFile, parseCsvRow, parseInstrumentCsv, parseKiteBinary, EQUITIES, INDEXES };
