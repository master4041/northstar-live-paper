const STARTING_CASH = 500000;

export function emptyPaperAccount(cash = STARTING_CASH) {
  return { cash, positions: {}, orders: [], trades: [], realizedPnl: 0 };
}

export function readPaperAccount(storage, key = 'northstar-paper-v2') {
  try {
    const saved = JSON.parse(storage.getItem(key));
    if (saved && Number.isFinite(saved.cash) && saved.positions && Array.isArray(saved.orders) && Array.isArray(saved.trades)) {
      return { ...emptyPaperAccount(), ...saved };
    }
  } catch {}
  return emptyPaperAccount();
}

export function savePaperAccount(storage, account, key = 'northstar-paper-v2') {
  storage.setItem(key, JSON.stringify(account));
}

export function markOrderFromQuote(account, order, quote, now = Date.now()) {
  if (!quote || !Number.isFinite(quote.last) || quote.last <= 0) throw new Error('A fresh live price is required.');
  if (!Number.isFinite(quote.receivedAt) || now - quote.receivedAt > 15000 || quote.receivedAt > now + 5000) throw new Error('The live quote is stale. Wait for a fresh price before practicing an order.');
  const quantity = Number(order.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantity must be a positive whole number.');
  if (!['BUY', 'SELL'].includes(order.side)) throw new Error('Choose buy or sell.');
  if (!order.symbol) throw new Error('Choose a security.');
  const type = order.type === 'LIMIT' ? 'LIMIT' : 'MARKET';
  const limit = Number(order.limitPrice);
  if (type === 'LIMIT' && (!Number.isFinite(limit) || limit <= 0)) throw new Error('Enter a valid limit price.');
  const newOrder = { id: `P${now}`, symbol: order.symbol, side: order.side, type, quantity, limitPrice: type === 'LIMIT' ? limit : null, status: 'PENDING', createdAt: now };
  const next = { ...account, positions: { ...account.positions }, orders: [...account.orders], trades: [...account.trades] };
  if (type === 'MARKET' || (order.side === 'BUY' && limit >= quote.last) || (order.side === 'SELL' && limit <= quote.last)) {
    return fillPaperOrder(next, newOrder, quote.last, now);
  }
  next.orders.unshift(newOrder);
  return { account: next, order: newOrder, filled: false };
}

export function fillPaperOrder(account, order, price, now = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('Fill price must be positive.');
  const next = { ...account, positions: { ...account.positions }, orders: [...account.orders], trades: [...account.trades] };
  const current = next.positions[order.symbol] || { quantity: 0, averagePrice: 0 };
  const value = price * order.quantity;
  if (order.side === 'BUY') {
    if (next.cash < value) throw new Error('Not enough paper cash for this order.');
    next.cash -= value;
    const quantity = current.quantity + order.quantity;
    next.positions[order.symbol] = { quantity, averagePrice: ((current.quantity * current.averagePrice) + value) / quantity };
  } else {
    if (current.quantity < order.quantity) throw new Error('Paper account does not hold enough shares to sell.');
    next.cash += value;
    next.realizedPnl += (price - current.averagePrice) * order.quantity;
    const remaining = current.quantity - order.quantity;
    if (remaining === 0) delete next.positions[order.symbol];
    else next.positions[order.symbol] = { ...current, quantity: remaining };
  }
  const filledOrder = { ...order, status: 'FILLED', fillPrice: price, filledAt: now };
  const existing = next.orders.findIndex(item => item.id === order.id);
  if (existing >= 0) next.orders[existing] = filledOrder;
  else next.orders.unshift(filledOrder);
  next.trades.unshift({ id: `T${now}`, orderId: order.id, symbol: order.symbol, side: order.side, quantity: order.quantity, price, value, time: now });
  return { account: next, order: filledOrder, filled: true };
}

export function processPaperLimits(account, symbol, livePrice, now = Date.now()) {
  let next = { ...account, positions: { ...account.positions }, orders: [...account.orders], trades: [...account.trades] };
  const filled = [];
  for (const order of next.orders) {
    if (order.status !== 'PENDING' || order.symbol !== symbol) continue;
    const crossed = order.side === 'BUY' ? livePrice <= order.limitPrice : livePrice >= order.limitPrice;
    if (!crossed) continue;
    try {
      const result = fillPaperOrder(next, order, livePrice, now);
      next = result.account;
      filled.push(result.order);
    } catch (error) {
      order.status = 'REJECTED';
      order.reason = error.message;
    }
  }
  return { account: next, filled };
}

