// Upgrade test in a real Chromium: a sheet saved by an older version (the row from a user's CSV export:
// pronouns as job title, no company, a LinkedIn URL typed by hand, the old export columns) must be repaired,
// filled in, and exported with the newer columns.  Run: node tests/e2e_upgrade.js
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

(async () => {
  const { chromium } = loadPlaywright();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llf-upgrade-'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llf-upgrade-dl-'));
  // What version 2.0/2.1 saved: its export columns, and the row exactly as in the user's CSV.
  fs.writeFileSync(path.join(dataDir, 'session.json'), JSON.stringify({
    version: 2, nextId: 2,
    settings: { maxLeads: 0, exportScope: 'all',
      exportColumns: ['no', 'name', 'firstName', 'lastName', 'title', 'company', 'location', 'url', 'statusText', 'confidence',
        'degree', 'query', 'source', 'note'] },
    rows: [{ id: 1, name: 'RajKumar Thanigaimalai', firstName: 'RajKumar', lastName: 'Thanigaimalai', title: 'He/Him',
      company: '', location: '', url: 'https://www.linkedin.com/in/rajkumar-digital-marketer', status: 'Manual',
      source: 'Sales Navigator', note: 'Entered by you', query: 'site:linkedin.com/in/ "RajKumar Thanigaimalai"' }],
  }));
  const port = await freePort();
  const srv = spawn(process.platform === 'win32' ? 'python' : 'python3',
    [path.join(APP, 'server.py'), '--port', String(port), '--no-browser', '--provider', 'mock'],
    { env: Object.assign({}, process.env, { LLF_DATA_DIR: dataDir }) });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });
  const base = 'http://127.0.0.1:' + port + '/';
  await waitFor(() => new Promise(r => http.get(base + 'api/health', x => { x.resume(); r(x.statusCode === 200); }).on('error', () => r(false))), 10000, 'server');

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  const step = name => console.log('  ✓ ' + name);
  const row = () => page.evaluate(() => window.__llf.state.rows[0]);

  try {
    await page.goto(base);
    await waitFor(() => page.evaluate(() => window.__llf && window.__llf.state.rows.length === 1), 8000, 'saved sheet');
    const cols = await page.evaluate(() => window.__llf.state.settings.exportColumns);
    for (const k of ['email', 'emailGuess', 'phone', 'companyPhone', 'website', 'companyUrl', 'match']) assert.ok(cols.includes(k), k);
    assert.equal((await row()).title, '', '"He/Him" is not a job title');
    step('older saved settings get the new export columns; "He/Him" removed from the job title');

    await page.check('#findEmail');
    await page.check('#findPhone');
    await page.click('#companyInfoBtn');
    await waitFor(async () => /Finished/.test(await page.textContent('#progressText')), 30000, 'company details');
    let r = await row();
    assert.deepEqual([r.title, r.company, r.location], ['Digital Marketing Manager', 'Mock Media Pvt Ltd', 'Chennai']);
    assert.ok(r.website, 'company website found once the company is known');
    assert.match(await page.textContent('#progressText'), /Read 1 LinkedIn profile \(1 filled in title\/company\)/);
    step('typed-in LinkedIn URL: title, company and location read from the profile; company website found');

    await page.click('#contactBtn');
    await waitFor(async () => /Finished/.test(await page.textContent('#progressText')), 30000, 'free contacts');
    r = await row();
    assert.ok(r.email || r.emailGuess || r.companyPhone, JSON.stringify(r));
    step('free finder ran for the row: ' + JSON.stringify({ email: r.email, guess: r.emailGuess, companyPhone: r.companyPhone }));

    // The same kind of page pasted again: pronouns, "2nd degree connection" and "Current:" lines.
    await page.fill('#pasteBox', ['Priya Raman', 'View Priya Raman’s profile', 'Priya Raman (She/Her)', ' • 3rd+', '3rd+ degree connection',
      'She/Her', 'Head of Sales at Zenith Labs', 'Bengaluru, Karnataka, India', 'Message', '',
      'Arun Kumar', 'View Arun Kumar’s profile', 'Arun Kumar', ' • 2nd', '2nd degree connection', 'He/Him',
      'Digital Marketer | SEO | Performance Marketing', 'Chennai, Tamil Nadu, India', 'Current: Growth Lead at Bluepeak Health',
      '12 other mutual connections', 'Connect'].join('\n'));
    await page.click('#parseBtn');
    const added = await page.evaluate(() => window.__llf.state.rows.slice(1).map(x => [x.name, x.title, x.company, x.location]));
    assert.deepEqual(added, [['Priya Raman', 'Head of Sales', 'Zenith Labs', 'Bengaluru, Karnataka, India'],
      ['Arun Kumar', 'Growth Lead', 'Bluepeak Health', 'Chennai, Tamil Nadu, India']]);
    step('LinkedIn search page paste: pronouns ignored, title + company from the headline or the "Current:" line');

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csvBtn')]);
    const file = path.join(dlDir, dl.suggestedFilename());
    await dl.saveAs(file);
    const header = fs.readFileSync(file, 'utf8').split('\r\n')[0];
    for (const h of ['Email', 'Email (guessed)', 'Phone', 'Company Phone', 'Company Website', 'Title on LinkedIn']) assert.ok(header.includes(h), h);
    step('CSV now has Email, Email (guessed), Phone, Company Phone, Company Website columns');

    assert.deepEqual(problems, []);
    step('no JavaScript errors');
    console.log('\nUPGRADE E2E PASSED');
  } catch (e) {
    console.error('\nUPGRADE E2E FAILED:', e.message);
    if (problems.length) console.error(problems.join('\n'));
    console.error('Server output:\n' + srvOut);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
