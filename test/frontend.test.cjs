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

test('GitHub Pages uses relative assets and never starts the live Kite API feed', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] || '';
  assert.match(script, /from ['"]\.\/paper\.mjs['"]/);
  assert.match(script, /location\.hostname\.endsWith\('\.github\.io'\)/);
  assert.match(script, /if\(isPagesHost\)\{syncFeed\(\);return\}/);
  assert.match(script, /function connectStream\(\)\{if\(isPagesHost\)return;/);
  assert.match(script, /STATIC PREVIEW · NO LIVE FEED/);
  assert.match(script, /GitHub Pages is static/);
  assert.match(script, /Northstar — Investing workspace preview/);
  assert.match(script, /Market data is unavailable on this public preview/);
  assert.match(script, /Live data requires the local server/);
});

test('GitHub Pages docs export stays byte-for-byte aligned with the local app', () => {
  const project = path.join(__dirname, '..');
  for (const file of ['index.html', 'paper.mjs']) {
    assert.deepEqual(
      fs.readFileSync(path.join(project, 'docs', file)),
      fs.readFileSync(path.join(project, 'public', file)),
      `docs/${file} must match the app served locally`
    );
  }
});

