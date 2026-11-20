# Northstar Live Paper Desk

## GitHub Pages preview

The public GitHub Pages site is a static preview of the Northstar interface. It includes browser-local planning tools and does not request, display, or redistribute Kite market data. To enable live quotes for a personal session, run the Node server locally using the setup steps below. GitHub Pages cannot run the Node server or protect broker credentials for a public feed.

For this repository, configure GitHub Pages to deploy from branch `main`, folder `/public`.

Northstar now separates **live market data** from **paper trading**:

- Kite Connect supplies live quotes and historical candles after you sign in.
- A local Node server keeps the Kite API secret and access token off the browser page.
- Paper cash, positions, pending limit orders, simulated fills, watchlist and theme are saved in this browser's `localStorage`.
- The server has no order-placement route. It cannot submit a buy or sell order to Kite.

This is a personal local prototype. NSE market-data display and redistribution rights depend on the applicable data agreements. Do not expose this local feed as a public service without checking those rights.

## Requirements

- Node.js 22 or newer
- An active Zerodha account and Kite Connect developer app
- Kite Connect API key and API secret
- Kite Connect access for live market data; check Zerodha's current plan and applicable display terms

Kite's API login is a daily session. Northstar keeps the access token in server memory and forgets it when you stop the server. Sign in again after restarting or after the token expires.

## Setup

1. In the Kite Connect developer console, create a personal app and set its redirect URL to `http://127.0.0.1:3000/kite/callback`.
2. Copy `.env.example` to `.env` in this folder.
3. Add your API key and API secret to `.env`. Do not put the secret in browser code or share it in chat.
4. From this folder, run `npm start`.
5. Open `http://127.0.0.1:3000` and choose **Connect Kite**. Complete Zerodha's login in the browser.

The app binds only to `127.0.0.1`. It streams the following NSE/BSE sample symbols when present in Kite's instrument master: RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK, ITC, SUNPHARMA, TATAMOTORS, NIFTY 50, SENSEX and NIFTY BANK. Some index symbols may not be available in every instrument list; the equities will still connect.

## Paper order behavior

- Market orders simulate a fill at the latest quote received by the page.
- Limit orders are saved locally and fill only after a later live quote reaches the limit.
- Buy orders cannot exceed the paper cash balance. Sell orders cannot exceed paper holdings.
- Paper activity never calls Kite order endpoints and has no brokerage/tax/slippage model.
- Resetting the paper account deletes its saved browser-local paper ledger after a confirmation prompt.

## Run tests

```sh
npm test
```

The tests cover browser-script syntax and key controls, quote packet decoding, instrument parsing, the Kite token-exchange checksum, local-only API routes, stale-price guards, and paper-account validation/fills. A real quote-stream test requires your Kite credentials and an authenticated account; no credentials are included in this project.

