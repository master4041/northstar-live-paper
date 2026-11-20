'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('browser module parses and its key interactive targets exist', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(script, 'module script should exist');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-front-'));
  const tempFile = path.join(tempDir, 'app.mjs');
  try {
    fs.writeFileSync(tempFile, script[1]);
    execFileSync(process.execPath, ['--check', tempFile], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  for (const id of ['nav', 'feed-badge', 'connect-btn', 'paper-order', 'market-table', 'positions-body', 'basket-legs', 'calc-tabs', 'orders-body', 'theme-toggle']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing UI target #${id}`);
  }
  assert.doesNotMatch(script[1], /fetch\s*\([^)]*\/api\/(?:orders|order|trade)\b/i, 'browser must not send simulated orders to a broker endpoint');
});
