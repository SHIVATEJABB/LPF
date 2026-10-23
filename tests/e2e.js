// End-to-end test in a real Chromium: paste -> search (mock + fake SerpApi) -> export downloads -> reload.
// Run: node tests/e2e.js   (needs Playwright; uses NODE_PATH or the global install)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

function loadPlaywright() {
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  try { tries.push(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); } catch (e) { /* no npm */ }
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  throw new Error('Playwright is not installed');
}

const APP = path.resolve(__dirname, '..');
const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'saved_leads_sample.txt'), 'utf8');

function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 150));
  }
}

function readXlsx(file) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  return JSON.parse(execFileSync(py, ['-c', [
    'import sys, json, openpyxl',
    'ws = openpyxl.load_workbook(sys.argv[1]).active',
    'print(json.dumps([[c.value for c in r] for r in ws.iter_rows()]))',
  ].join('\n'), file]).toString());
}

(async () => {
  const { chromium } = loadPlaywright();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llf-e2e-'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llf-dl-'));

  // Fake SerpApi that rejects the key, to prove a bad key stops the run immediately.
  let upstreamCalls = 0;
  const fake = http.createServer((req, res) => {
    upstreamCalls++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' }));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));

  const port = await freePort();
  const srv = spawn(process.platform === 'win32' ? 'python' : 'python3',
    [path.join(APP, 'server.py'), '--port', String(port), '--no-browser', '--provider', 'mock'],
    { env: Object.assign({}, process.env, { LLF_DATA_DIR: dataDir, LLF_SERPAPI_URL: 'http://127.0.0.1:' + fake.address().port, SERPAPI_KEY: '' }) });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });
  const base = 'http://127.0.0.1:' + port + '/';
  await waitFor(() => new Promise(r => http.get(base + 'api/health', x => { x.resume(); r(x.statusCode === 200); }).on('error', () => r(false))), 10000, 'server');

  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  const step = name => console.log('  ✓ ' + name);

  try {
    await page.goto(base);
    await waitFor(async () => (await page.textContent('#serverStatus')).includes('Mock'), 5000, 'mock status chip');
    step('page loads, server connected, mock mode shown');

    // 1. Paste the real Sales Navigator text.
    await page.fill('#pasteBox', SAMPLE);
    await page.click('#parseBtn');
    assert.equal(await page.locator('#tbody tr[data-id]:not(.details)').count(), 25);
    assert.match(await page.textContent('#parseMsg'), /Added 25 new leads/);
    assert.equal(await page.inputValue('#pasteBox'), '');
    step('25 leads parsed from the pasted page');

    await page.fill('#pasteBox', SAMPLE);
    await page.click('#parseBtn');
    assert.match(await page.textContent('#parseMsg'), /Added 0 new leads · 25 duplicates skipped/);
    assert.equal(await page.evaluate(() => window.__llf.state.rows.length), 25);
    step('pasting the same page again adds no duplicates');

    // 2. Custom limits.
    await page.fill('#maxLeads', '3000');
    await page.dispatchEvent('#maxLeads', 'change');
    assert.match(await page.textContent('#estimate'), /^25 leads will be searched/);
    await page.fill('#maxLeads', '10');
    await page.dispatchEvent('#maxLeads', 'change');
    assert.match(await page.textContent('#estimate'), /^10 leads will be searched/);
    await page.fill('#startRow', '21');
    await page.dispatchEvent('#startRow', 'change');
    assert.match(await page.textContent('#estimate'), /^5 leads will be searched/);
    await page.fill('#maxLeads', '0');
    await page.dispatchEvent('#maxLeads', 'change');
    await page.fill('#startRow', '1');
    await page.dispatchEvent('#startRow', 'change');
    step('custom limits: 3000 / 10 / start row 21 all respected');

    // 3. Search all 25 with the mock provider.
    await page.click('#runBtn');
    await waitFor(async () => /Finished/.test(await page.textContent('#progressText')), 60000, 'mock search to finish');
    const counts = await page.evaluate(() => {
      const c = {};
      window.__llf.state.rows.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
      return c;
    });
    assert.equal((counts.Matched || 0) + (counts.Review || 0) + (counts['Not found'] || 0), 25, JSON.stringify(counts));
    assert.ok(counts.Matched >= 8, JSON.stringify(counts));
    assert.ok(!counts.Error && !counts.Searching && !counts.Pending, JSON.stringify(counts));
    const leaked = await page.evaluate(() => window.__llf.state.rows.filter(r => /\/(posts|company)\//.test(r.url)).length);
    assert.equal(leaked, 0);
    step('mock search finished: ' + JSON.stringify(counts));

    // 4. Downloads.
    const [xdl] = await Promise.all([page.waitForEvent('download'), page.click('#xlsxBtn')]);
    assert.match(xdl.suggestedFilename(), /^linkedin-leads_\d{4}-\d{2}-\d{2}_\d{4}\.xlsx$/);
    const xfile = path.join(dlDir, xdl.suggestedFilename());
    await xdl.saveAs(xfile);
    const sheet = readXlsx(xfile);
    assert.equal(sheet.length, 26);
    assert.deepEqual(sheet[0].slice(0, 8), ['No.', 'Full Name', 'First Name', 'Last Name', 'Job Title', 'Company', 'Location', 'LinkedIn URL']);
    assert.deepEqual(sheet[1].slice(0, 7), [1, 'Dr. Kerlin Sara Wilson', 'Kerlin', 'Sara Wilson', 'Head of Strategic Operations & Corporate Relations', 'nice Neotech Medical Systems Pvt. Ltd.', 'Chennai, Tamil Nadu, India']);
    step('Excel download works and opens: ' + sheet.length + ' rows incl. header');

    const [cdl] = await Promise.all([page.waitForEvent('download'), page.click('#csvBtn')]);
    const cfile = path.join(dlDir, cdl.suggestedFilename());
    await cdl.saveAs(cfile);
    const csv = fs.readFileSync(cfile, 'utf8');
    assert.ok(csv.startsWith('﻿No.,Full Name,'));
    assert.equal(csv.trim().split('\r\n').length, 26);
    step('CSV download works: ' + cfile.split(path.sep).pop());

    await page.selectOption('#exportScope', 'matched');
    const [mdl] = await Promise.all([page.waitForEvent('download'), page.click('#xlsxBtn')]);
    const mfile = path.join(dlDir, 'matched.xlsx');
    await mdl.saveAs(mfile);
    assert.equal(readXlsx(mfile).length, counts.Matched + 1);
    await page.selectOption('#exportScope', 'all');
    step('"matched only" export has exactly the matched rows');

    // 5. Manual URL entry on a row.
    const target = await page.evaluate(() => window.__llf.state.rows.findIndex(r => r.status !== 'Matched'));
    await page.click('.pill[data-f="all"]');
    const input = page.locator('#tbody tr[data-id] input.url').nth(target);
    await input.fill('in.linkedin.com/in/Someone-Real/');
    await input.press('Enter');
    await input.evaluate(e => e.blur());
    await waitFor(() => page.evaluate(i => window.__llf.state.rows[i].status === 'Manual', target), 3000, 'manual status');
    assert.equal(await page.evaluate(i => window.__llf.state.rows[i].url, target), 'https://www.linkedin.com/in/someone-real');
    step('typing a URL by hand marks the row as confirmed');

    // 6. Custom lead search (X-ray) with a custom target.
    await page.click('.tab[data-tab="xray"]');
    await page.fill('#xTitles', 'Head of Operations\nFounder');
    await page.dispatchEvent('#xTitles', 'change');
    await page.fill('#xLocations', 'Chennai');
    await page.dispatchEvent('#xLocations', 'change');
    await page.fill('#xTarget', '30');
    await page.dispatchEvent('#xTarget', 'change');
    await page.click('#xPreview');
    assert.equal((await page.textContent('#xQueries')).trim().split('\n').length, 2);
    await page.click('#xRun');
    await waitFor(async () => /Finished/.test(await page.textContent('#progressText')), 60000, 'x-ray search');
    const found = await page.evaluate(() => window.__llf.state.rows.filter(r => r.status === 'Found').length);
    assert.equal(found, 30);
    step('custom lead search found exactly the 30 leads asked for');

    // 7. Stop button.
    await page.fill('#xTarget', '500');
    await page.dispatchEvent('#xTarget', 'change');
    await page.fill('#xTitles', 'Engineer\nManager\nDirector\nAnalyst');
    await page.dispatchEvent('#xTitles', 'change');
    await page.click('#xRun');
    await page.waitForTimeout(400);
    await page.click('#stopBtn');
    await waitFor(async () => /Stopped/.test(await page.textContent('#progressText')), 15000, 'stop');
    assert.equal(await page.isDisabled('#runBtn'), false);
    step('Stop button halts a running search');

    // 7b. Company search -> pick companies -> people at those companies (strict, current company).
    await page.click('.tab[data-tab="company"]');
    await page.fill('#cKeywords', 'roofing');
    await page.dispatchEvent('#cKeywords', 'change');
    await page.fill('#cLocations', 'Dallas');
    await page.dispatchEvent('#cLocations', 'change');
    await page.check('#cSizes input[data-k="11-50"]');
    await page.check('#cSizes input[data-k="51-200"]');
    await page.fill('#cTarget', '15');
    await page.dispatchEvent('#cTarget', 'change');
    await page.click('#cRun');
    await waitFor(async () => /Finished/.test(await page.textContent('#progressText')), 60000, 'company search');
    const cos = await page.evaluate(() => window.__llf.state.companies.map(c => ({ name: c.name, b: c.sizeBucket, url: c.url })));
    assert.equal(cos.length, 15);
    assert.ok(cos.every(c => ['11-50', '51-200', ''].includes(c.b)), JSON.stringify(cos.map(c => c.b)));
    assert.ok(cos.every(c => c.url.startsWith('https://www.linkedin.com/company/')));
    assert.equal(await page.locator('#companyTbody tr').count(), 15);
    step('company search found 15 companies, size filter respected');

    const [cdl2] = await Promise.all([page.waitForEvent('download'), page.click('#cXlsxBtn')]);
    const cofile = path.join(dlDir, 'companies.xlsx');
    await cdl2.saveAs(cofile);
    const cosheet = readXlsx(cofile);
    assert.equal(cosheet.length, 16);
    assert.equal(cosheet[0][1], 'Company');
    step('company list downloads as Excel');

    await page.click('#cSelectNone');
    const boxes = page.locator('#companyTbody input.csel');
    for (let i = 0; i < 3; i++) await boxes.nth(i).check();
    await page.click('#cUseBtn');
    assert.equal(await page.isVisible('#tab-xray'), true);
    const picked = (await page.inputValue('#xCompanies')).split('\n');
    assert.deepEqual(picked, cos.slice(0, 3).map(c => c.name));
    assert.equal(await page.isChecked('#xCurrentOnly'), true);
    step('3 selected companies copied into Lead search');

    await page.fill('#xTitles', 'Head of Sales');
    await page.dispatchEvent('#xTitles', 'change');
    await page.check('#xSeniority input[data-k="vp"]');
    await page.fill('#xLocations', 'Dallas');
    await page.dispatchEvent('#xLocations', 'change');
    await page.check('#xStrict');
    await page.fill('#xPages', '2');
    await page.dispatchEvent('#xPages', 'change');
    await page.fill('#xTarget', '20');
    await page.dispatchEvent('#xTarget', 'change');
    await page.click('#xPreview');
    assert.equal((await page.textContent('#xQueries')).trim().split('\n').length, 9); // 3 titles x 3 companies x 1 region
    const before7b = await page.evaluate(() => window.__llf.state.rows.length);
    await page.click('#xRun');
    await waitFor(async () => /Finished/.test(await page.textContent('#progressText')), 60000, 'company people search');
    const people = await page.evaluate(n => window.__llf.state.rows.slice(n), before7b);
    assert.equal(people.length, 20);
    const names = cos.slice(0, 3).map(c => c.name);
    assert.ok(people.every(r => r.status === 'Found' && r.source === 'Lead search'), JSON.stringify(people.map(r => r.status)));
    assert.ok(people.every(r => names.includes(r.company)), JSON.stringify(people.map(r => r.company)));
    assert.ok(people.every(r => r.match === 'Title ✓ · Company ✓ · Location ✓'), people[0].match);
    assert.match(await page.textContent('#progressText'), /left out by strict mode/);
    step('people search at those companies: 20 leads, all match every filter (strict mode)');

    // 8. Reload keeps everything.
    const before = await page.evaluate(() => window.__llf.state.rows.length);
    await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));
    await page.reload();
    await waitFor(() => page.evaluate(n => window.__llf && window.__llf.state.rows.length === n
      && window.__llf.state.companies.length === 15, before), 8000, 'restored rows and companies');
    step('after reload all ' + before + ' rows are restored');

    // 9. A rejected API key stops the run straight away (no wasted credits).
    await page.click('#openSettings');
    await page.selectOption('#provider', 'serpapi');
    await page.fill('#apiKey', 'wrong-key-123');
    await page.press('#apiKey', 'Enter');
    await waitFor(async () => /Key saved/.test(await page.textContent('#testMsg')), 5000, 'key saved with Enter');
    assert.ok(await page.evaluate(() => document.getElementById('settings').open), 'Enter must not close Settings');
    await page.click('#testKeyBtn');
    await waitFor(async () => /Invalid API key/.test(await page.textContent('#testMsg')), 5000, 'key test message');
    await page.keyboard.press('Escape');
    await page.uncheck('#onlyNew');
    await page.dispatchEvent('#onlyNew', 'change');
    upstreamCalls = 0;
    await page.click('#runBtn');
    await waitFor(async () => /Search stopped/.test(await page.textContent('#bannerText')), 20000, 'fatal stop banner');
    assert.ok(upstreamCalls <= 3, 'calls after bad key: ' + upstreamCalls);
    const after = await page.evaluate(() => window.__llf.state.rows.filter(r => r.status === 'Pending' || r.status === 'Error').length);
    assert.equal(after, 0, 'rows keep their earlier results');
    assert.match(await page.textContent('#progressText'), /^Stopped by an error/);
    step('bad API key: run stops after ' + upstreamCalls + ' call(s), banner explains why');

    // 10. Mobile width: the page itself must not scroll sideways.
    await page.setViewportSize({ width: 390, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, 'horizontal overflow ' + overflow + 'px');
    step('phone width: no sideways scrolling');
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.screenshot({ path: path.join(dlDir, 'screenshot.png'), fullPage: false });

    assert.deepEqual(problems, []);
    step('no JavaScript errors in the console');
    console.log('\nE2E PASSED. Downloads and screenshot in ' + dlDir);
  } catch (e) {
    console.error('\nE2E FAILED:', e.message);
    if (problems.length) console.error('Browser problems:\n' + problems.join('\n'));
    console.error('Server output:\n' + srvOut);
    try { await page.screenshot({ path: path.join(dlDir, 'failure.png'), fullPage: true }); console.error('Screenshot: ' + path.join(dlDir, 'failure.png')); } catch (e2) { /* ignore */ }
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
    fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
