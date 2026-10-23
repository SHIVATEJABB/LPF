// Unit tests for static/core.js.  Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../static/core.js');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'saved_leads_sample.txt'), 'utf8');

test('saved-leads paste: finds all 25 people with clean fields', () => {
  const r = C.parseLeads(SAMPLE);
  assert.equal(r.mode, 'sales-navigator');
  assert.equal(r.leads.length, 25);
  assert.equal(r.duplicates, 0);
  const by = Object.fromEntries(r.leads.map(l => [l.name, l]));
  assert.deepEqual(
    [by['Dr. Kerlin Sara Wilson'].title, by['Dr. Kerlin Sara Wilson'].company, by['Dr. Kerlin Sara Wilson'].location, by['Dr. Kerlin Sara Wilson'].degree],
    ['Head of Strategic Operations & Corporate Relations', 'nice Neotech Medical Systems Pvt. Ltd.', 'Chennai, Tamil Nadu, India', '2nd']);
  assert.equal(by['Pranavamurthy K S'].degree, '3rd');
  assert.equal(by['Ramya D'].title, 'Head, Department of Biotechnology');
  assert.equal(by['Ramya D'].location, 'Karaikal, Puducherry, India');
  assert.equal(by['Tanisha Priya'].company, 'iOS Development Centre, SRMIST, Chennai');
  assert.equal(by['Chandipriya Nagesh'].company, 'FPS Assets | First Principles Asset Services LLP');
  // "Add Account" rows have no company - never a neighbour's company.
  for (const n of ['Mahamootha Banu A', 'Naga Raj Thirumal', 'Dr. R. Anitha Elango']) assert.equal(by[n].company, '', n);
  assert.equal(by['Mahamootha Banu A'].location, 'Greater Chennai Area');
  assert.equal(by['Prof Dr. Hariharan Ramakrishnan'].title, 'Head');
  // No junk survives anywhere.
  const junk = /saved badge|degree connection|add note|no activity|add account|account matching|\(\+\d\)|^\d+ lists?$|profile picture|8\/27\/2026|^(1st|2nd|3rd)$/i;
  for (const l of r.leads) for (const f of ['name', 'title', 'company', 'location']) assert.ok(!junk.test(l[f]), l.name + ' ' + f + ': ' + l[f]);
  // Order is preserved.
  assert.equal(r.leads[0].name, 'Dr. Kerlin Sara Wilson');
  assert.equal(r.leads[24].name, 'Atanu Das');
});

test('first and last names are outreach-ready', () => {
  const by = Object.fromEntries(C.parseLeads(SAMPLE).leads.map(l => [l.name, l]));
  assert.deepEqual([by['Dr. Kerlin Sara Wilson'].firstName, by['Dr. Kerlin Sara Wilson'].lastName], ['Kerlin', 'Sara Wilson']);
  assert.deepEqual([by['THOTHADRI SETHURAMAN'].firstName, by['THOTHADRI SETHURAMAN'].lastName], ['Thothadri', 'Sethuraman']);
  assert.deepEqual([by['Dr. R. Anitha Elango'].firstName, by['Dr. R. Anitha Elango'].lastName], ['Anitha', 'Elango']);
  assert.deepEqual([by['Prof Dr. Hariharan Ramakrishnan'].firstName, by['Prof Dr. Hariharan Ramakrishnan'].lastName], ['Hariharan', 'Ramakrishnan']);
  assert.equal(by['partthiban saketharaman'].firstName, 'Partthiban');
});

test('pasting two pages (with repeated headers) skips duplicates', () => {
  const r = C.parseLeads(SAMPLE + '\n' + SAMPLE);
  assert.equal(r.leads.length, 25);
  assert.equal(r.duplicates, 25);
});

test('LF line endings and lost tabs still parse', () => {
  const r = C.parseLeads(SAMPLE.replace(/\r\n/g, '\n').replace(/\t/g, ''));
  assert.equal(r.leads.length, 25);
  const kavin = r.leads.find(l => l.name === 'Kavin Venkatesh');
  assert.deepEqual([kavin.title, kavin.company, kavin.location], ['Executive Director', 'Maybell', 'Chennai, Tamil Nadu, India']);
});

test('Sales Navigator search-results style page', () => {
  const text = [
    'Select all', '1–25 of 312 results', '',
    'Select Jane Doe', 'Jane Doe’s profile picture', 'Jane Doe', '2nd', 'Vice President of Sales', 'Acme Roofing Inc.',
    'Dallas, Texas, United States', '2 years 3 months in role', '5 years 1 month in company',
    'About: Experienced sales leader with a passion for building teams across the southwest and more.', 'See more', 'Message', 'Save', '',
    'Select John O’Brien, MBA', 'John O’Brien, MBA’s profile picture', 'John O’Brien, MBA', '3rd', 'Owner', 'O’Brien Exteriors LLC',
    'Houston, Texas', 'Recently hired', '12 mutual connections', 'Message', 'Save',
  ].join('\n');
  const r = C.parseLeads(text);
  assert.equal(r.leads.length, 2);
  assert.deepEqual([r.leads[0].name, r.leads[0].title, r.leads[0].company, r.leads[0].location],
    ['Jane Doe', 'Vice President of Sales', 'Acme Roofing Inc.', 'Dallas, Texas, United States']);
  assert.deepEqual([r.leads[1].title, r.leads[1].company, r.leads[1].location], ['Owner', 'O’Brien Exteriors LLC', 'Houston, Texas']);
  assert.equal(C.searchName(r.leads[1].name), 'John O’Brien');
});

test('regular LinkedIn search page with "Title at Company"', () => {
  const text = 'Michael Johnson\nView Michael Johnson’s profile\n• 2nd\nPresident at XYZ Roofing\nHouston, Texas, United States\nConnect\n\n'
    + 'David Williams\nView David Williams’ profile\n• 3rd\nCFO at Global Roofing Solutions\nAustin, Texas, United States\nFollow\n';
  const r = C.parseLeads(text);
  assert.equal(r.leads.length, 2);
  assert.deepEqual([r.leads[0].name, r.leads[0].title, r.leads[0].company, r.leads[0].location, r.leads[0].degree],
    ['Michael Johnson', 'President', 'XYZ Roofing', 'Houston, Texas, United States', '2nd']);
  assert.deepEqual([r.leads[1].name, r.leads[1].title, r.leads[1].company], ['David Williams', 'CFO', 'Global Roofing Solutions']);
});

test('plain blocks: name / "Title at Company" / location', () => {
  const r = C.parseLeads('John Smith\nCEO at ABC Roofing\nDallas, Texas, United States\n\nMichael Johnson\nPresident at XYZ Roofing\nHouston, Texas, United States\n');
  assert.equal(r.mode, 'blocks');
  assert.deepEqual(r.leads.map(l => [l.name, l.title, l.company, l.location]), [
    ['John Smith', 'CEO', 'ABC Roofing', 'Dallas, Texas, United States'],
    ['Michael Johnson', 'President', 'XYZ Roofing', 'Houston, Texas, United States'],
  ]);
});

test('pipe rows', () => {
  const r = C.parseLeads('[ John Smith | CEO | ABC Roofing | Dallas ]\n[ Michael Johnson | President | XYZ Roofing | Houston ]');
  assert.equal(r.mode, 'pipe');
  assert.deepEqual(r.leads.map(l => [l.name, l.title, l.company, l.location]), [
    ['John Smith', 'CEO', 'ABC Roofing', 'Dallas'], ['Michael Johnson', 'President', 'XYZ Roofing', 'Houston']]);
});

test('CSV and TSV tables with headers, quoted commas and existing URLs', () => {
  const csv = 'First Name,Last Name,Job Title,Company,Location,LinkedIn URL\r\n'
    + 'John,Smith,CEO,"ABC Roofing, Inc.","Dallas, Texas",https://www.linkedin.com/in/john-smith-1/\r\n'
    + 'Jane,Roe,"VP ""Ops""",Roe Co,Austin,\r\n';
  const r = C.parseLeads(csv);
  assert.equal(r.mode, 'table');
  assert.deepEqual(r.leads.map(l => [l.name, l.title, l.company, l.location, l.url]), [
    ['John Smith', 'CEO', 'ABC Roofing, Inc.', 'Dallas, Texas', 'https://www.linkedin.com/in/john-smith-1'],
    ['Jane Roe', 'VP "Ops"', 'Roe Co', 'Austin', ''],
  ]);
  const tsv = 'Name\tTitle\tAccount\tGeography\nAsha Rao\tFounder\tRao Labs\tPune, Maharashtra, India\n';
  const t = C.parseLeads(tsv);
  assert.equal(t.mode, 'table');
  assert.deepEqual([t.leads[0].name, t.leads[0].company, t.leads[0].location], ['Asha Rao', 'Rao Labs', 'Pune, Maharashtra, India']);
});

test('empty or junk input gives no leads and does not throw', () => {
  assert.equal(C.parseLeads('').leads.length, 0);
  assert.equal(C.parseLeads('Saved Badge\n2nd\nAdd note\n8/27/2026\n').leads.length, 0);
  assert.equal(C.parseLeads('Name\tAccount\tGeography\tNotes Tooltip\nOutreach activity\tDate added\tActions').leads.length, 0);
});

test('name cleaning for search', () => {
  assert.equal(C.cleanPersonName('Prof  Dr. Hariharan Ramakrishnan'), 'Hariharan Ramakrishnan');
  assert.equal(C.cleanPersonName('Jane Doe, PhD, PMP'), 'Jane Doe');
  assert.equal(C.cleanPersonName('Raj Kumar (He/Him) 🚀'), 'Raj Kumar');
  assert.equal(C.cleanPersonName('Mary Smith MBA'), 'Mary Smith');
  assert.equal(C.searchName('Dr. R. Anitha Elango'), 'Anitha Elango');
  assert.equal(C.searchName('Mahamootha Banu A'), 'Mahamootha Banu');
  assert.equal(C.searchName('Pranavamurthy K S'), 'Pranavamurthy K S');
  assert.equal(C.searchName('John F. Kennedy'), 'John F Kennedy');
  assert.equal(C.searchName('Vipin C'), 'Vipin C');
});

test('queries: company cleaned, missing fields skip the template', () => {
  const lead = { name: 'Vipin C', title: 'Business Head', company: 'Sumo Technologies Private Limited', location: 'Chennai, Tamil Nadu, India' };
  assert.deepEqual(C.buildFindQueries(lead, C.DEFAULT_TEMPLATES), [
    'site:linkedin.com/in/ "Vipin C" "Sumo Technologies"',
    'site:linkedin.com/in/ "Vipin C" "Chennai"',
    'site:linkedin.com/in/ "Vipin C"',
  ]);
  const noCo = { name: 'Dr. R. Anitha Elango', title: 'Chief Learning Officer', company: '', location: 'Greater Chennai Area' };
  assert.deepEqual(C.buildFindQueries(noCo, C.DEFAULT_TEMPLATES), [
    'site:linkedin.com/in/ "Anitha Elango" "Chennai"', 'site:linkedin.com/in/ "Anitha Elango"']);
  assert.deepEqual(C.buildFindQueries({ name: 'A "B" C', company: 'X' }, ['{name} {company} {unknown}']), ['A B C X {unknown}']);
  assert.deepEqual(C.buildFindQueries({ name: '' }, C.DEFAULT_TEMPLATES), []);
  assert.equal(C.companyForQuery('FPS Assets | First Principles Asset Services LLP'), 'FPS Assets');
  assert.equal(C.companyForQuery('KP Manish Global Ingredients Pvt. Ltd.'), 'KP Manish Global Ingredients');
  assert.equal(C.cityOf('San Francisco Bay Area'), 'San Francisco');
});

test('custom lead search queries', () => {
  const q = C.buildXrayQueries({ titles: 'Head of Operations\nFounder', locations: 'Chennai\nPune', keywords: '', excludes: 'intern, jobs' });
  assert.deepEqual(q, [
    'site:linkedin.com/in/ "Head of Operations" "Chennai" -"intern" -"jobs"',
    'site:linkedin.com/in/ "Head of Operations" "Pune" -"intern" -"jobs"',
    'site:linkedin.com/in/ "Founder" "Chennai" -"intern" -"jobs"',
    'site:linkedin.com/in/ "Founder" "Pune" -"intern" -"jobs"',
  ]);
  assert.deepEqual(C.buildXrayQueries({ titles: 'CEO\nFounder', locations: 'Dallas', keywords: 'roofing', combineTitles: true }),
    ['site:linkedin.com/in/ ("CEO" OR "Founder") "Dallas" "roofing"']);
  assert.deepEqual(C.buildXrayQueries({ raw: '"CFO" roofing Texas\nsite:linkedin.com/in/ "CTO"' }),
    ['site:linkedin.com/in/ "CFO" roofing Texas', 'site:linkedin.com/in/ "CTO"']);
  assert.deepEqual(C.buildXrayQueries({}), []);
});

test('LinkedIn URL normalisation', () => {
  const n = C.normalizeLinkedInUrl;
  assert.equal(n('https://in.linkedin.com/in/Sumit-Kumar-123/'), 'https://www.linkedin.com/in/sumit-kumar-123');
  assert.equal(n('https://www.linkedin.com/in/jane-doe/en?trk=x#a'), 'https://www.linkedin.com/in/jane-doe');
  assert.equal(n('http://linkedin.com/in/jos%C3%A9-garc%C3%ADa'), 'https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa');
  assert.equal(n('https://www.linkedin.com/pub/john-smith/1/23/456'), 'https://www.linkedin.com/pub/john-smith/1/23/456');
  for (const bad of ['https://www.linkedin.com/posts/abc', 'https://www.linkedin.com/company/acme', 'https://www.linkedin.com/pub/dir/John/Smith',
    'https://evil.com/in/john', 'https://linkedin.com.evil.com/in/john', 'javascript:alert(1)', 'not a url', '']) {
    assert.equal(n(bad), null, bad);
  }
});

test('Google result parsing', () => {
  const p = C.parseProfileResult({
    title: 'Sumit Kumar - Head of Operations - INOCYX | LinkedIn',
    link: 'https://in.linkedin.com/in/sumit-kumar-ops',
    snippet: 'Head of Operations at INOCYX · Experience: INOCYX · Education: Anna University · Location: Chennai · 500+ connections on LinkedIn.',
  });
  assert.deepEqual([p.name, p.title, p.company, p.location, p.url],
    ['Sumit Kumar', 'Head of Operations', 'INOCYX', 'Chennai', 'https://www.linkedin.com/in/sumit-kumar-ops']);
  const q = C.parseProfileResult({ title: 'Kavin Venkatesh – Maybell | LinkedIn', link: 'https://www.linkedin.com/in/kavinv', snippet: '', extras: ['Chennai, Tamil Nadu, India', 'Executive Director', 'Maybell'] });
  assert.deepEqual([q.name, q.company, q.location, q.title], ['Kavin Venkatesh', 'Maybell', 'Chennai, Tamil Nadu, India', 'Executive Director']);
  assert.equal(C.parseProfileResult({ title: 'x', link: 'https://www.linkedin.com/posts/x' }), null);
});

test('matching: right person, wrong company, wrong person', () => {
  const lead = { name: 'Sumit Kumar', title: 'Head of Operations', company: 'INOCYX', location: 'Chennai, Tamil Nadu, India' };
  const right = { title: 'Sumit Kumar - INOCYX | LinkedIn', link: 'https://in.linkedin.com/in/sumit-k', snippet: 'Head of Operations at INOCYX · Location: Chennai' };
  const otherCo = { title: 'Sumit Kumar - Tata Consultancy Services | LinkedIn', link: 'https://in.linkedin.com/in/sumit-tcs', snippet: 'Location: Chennai · 500+ connections' };
  const otherPerson = { title: 'Amit Sharma - INOCYX | LinkedIn', link: 'https://in.linkedin.com/in/amit', snippet: 'Location: Chennai' };
  const ranked = C.evaluateResults(lead, [otherPerson, otherCo, right, { title: 'Post', link: 'https://www.linkedin.com/posts/zz', snippet: '' }]);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].url, 'https://www.linkedin.com/in/sumit-k');
  assert.equal(ranked[0].verdict, 'Matched');
  assert.ok(ranked[0].confidence >= 90, String(ranked[0].confidence));
  assert.equal(ranked.find(c => c.url.endsWith('sumit-tcs')).verdict, 'Review');
  assert.equal(ranked.find(c => c.url.endsWith('/amit')).verdict, 'No match');
});

test('matching handles honorifics, initials, spelling and joined names', () => {
  const j = (lead, title, snippet) => C.judgeResult(lead, { title, link: 'https://www.linkedin.com/in/x', snippet: snippet || '' });
  assert.equal(j({ name: 'Prof Dr. Hariharan Ramakrishnan', company: 'Tagore Dental College and Hospital', title: 'Head' },
    'Dr. Hariharan Ramakrishnan - Tagore Dental College & Hospital | LinkedIn').verdict, 'Matched');
  assert.equal(j({ name: 'partthiban saketharaman', company: 'Tagore Dental College and Hospital' },
    'Parthiban Saketharaman - Tagore Dental College and Hospital | LinkedIn').verdict, 'Matched');
  assert.equal(j({ name: 'Naga Raj Thirumal', company: '', title: 'Founder', location: 'Chennai, Tamil Nadu, India' },
    'Nagaraj Thirumal - Founder - Thirumal Ventures | LinkedIn', 'Location: Chennai').verdict, 'Matched');
  assert.equal(j({ name: 'Vipin C', company: 'Sumo Technologies Private Limited' },
    'Vipin Chandran - Sumo Technologies Pvt Ltd | LinkedIn').verdict, 'Matched');
  assert.equal(j({ name: 'Achyuth pv', company: 'CodeKrafters' }, 'Achyuth PV - Code Krafters | LinkedIn').verdict, 'Matched');
  assert.equal(j({ name: 'Jane Doe', company: 'Acme', title: 'CEO' }, 'Jane Doe - Chief Executive Officer - Acme | LinkedIn').titleScore, 1);
  // A generic company word alone is not enough evidence.
  assert.notEqual(j({ name: 'Rakesh N', company: 'ANAND TECHVERCE' }, 'Rakesh N - Infosys Technologies | LinkedIn').verdict, 'Matched');
  // A weak name with only location as evidence stays in review.
  assert.notEqual(j({ name: 'Ramya D', company: '', location: 'Chennai, Tamil Nadu, India' }, 'Ramya D - Engineer | LinkedIn', 'Location: Chennai').verdict, 'Matched');
  // Location contradiction lowers the score.
  const a = j({ name: 'Meena Raja', company: 'Sri Muthukumaran Institute Of Technology', location: 'Chennai, Tamil Nadu, India' }, 'Meena Raja - Sri Muthukumaran Institute of Technology | LinkedIn', 'Location: Chennai');
  const b = j({ name: 'Meena Raja', company: 'Sri Muthukumaran Institute Of Technology', location: 'Chennai, Tamil Nadu, India' }, 'Meena Raja - Sri Muthukumaran Institute of Technology | LinkedIn', 'Location: London');
  assert.ok(a.confidence > b.confidence);
});

test('location detector', () => {
  for (const yes of ['Chennai, Tamil Nadu, India', 'Greater Chennai Area', 'Karaikal, Puducherry, India', 'Dallas, Texas', 'India', 'San Francisco Bay Area', 'Houston, Texas, United States']) assert.ok(C.isLocation(yes), yes);
  for (const no of ['Head, Department of Biotechnology', 'Operations Head, SRM Vadapalani Student Chapter', 'iOS Development Centre, SRMIST, Chennai', 'Country Manager, India', 'Founder, CEO', 'The New College, Chennai', 'Maybell']) assert.ok(!C.isLocation(no), no);
});

test('CSV: BOM, quoting and formula-injection guard', () => {
  const cols = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B, "quoted"' }];
  const csv = C.toCSV(cols, [{ a: '=HYPERLINK("x")', b: 'line1\nline2' }, { a: 'Ünïcödé', b: '+91 98' }]);
  assert.ok(csv.startsWith('﻿A,"B, ""quoted"""\r\n'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")","line1\nline2"'));
  assert.ok(csv.includes("Ünïcödé,'+91 98"));
});

test('XLSX: valid package that Excel/openpyxl can read', t => {
  const cols = [{ key: 'no', label: 'No.', type: 'number' }, { key: 'name', label: 'Full Name' }, { key: 'url', label: 'LinkedIn URL', type: 'url' }, { key: 'x', label: 'Notes' }];
  const rows = [
    { no: 1, name: 'Dr. Kerlin Sara Wilson', url: 'https://www.linkedin.com/in/kerlin', x: 'A & B <c> "d" \u0007bell' },
    { no: 2, name: 'Tanisha Priya', url: '', x: '' },
    { no: 3, name: 'José García', url: 'https://www.linkedin.com/in/jos%C3%A9', x: '=1+1' },
  ];
  const bytes = C.toXLSX(cols, rows, 'Leads');
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llf-')), 'test.xlsx');
  fs.writeFileSync(file, bytes);
  let py = null;
  for (const cand of ['python3', 'python']) { try { execFileSync(cand, ['-c', 'import openpyxl'], { stdio: 'ignore' }); py = cand; break; } catch (e) { /* try next */ } }
  if (!py) { t.skip('openpyxl not installed'); return; }
  const out = execFileSync(py, ['-c', [
    'import sys, json, zipfile, openpyxl',
    'assert zipfile.ZipFile(sys.argv[1]).testzip() is None',
    'ws = openpyxl.load_workbook(sys.argv[1]).active',
    'print(json.dumps({"title": ws.title, "rows": [[c.value for c in r] for r in ws.iter_rows()],',
    '  "link": ws["C2"].hyperlink.target if ws["C2"].hyperlink else None, "freeze": ws.freeze_panes, "filter": ws.auto_filter.ref}))',
  ].join('\n'), file]).toString();
  const res = JSON.parse(out);
  assert.equal(res.title, 'Leads');
  assert.deepEqual(res.rows[0], ['No.', 'Full Name', 'LinkedIn URL', 'Notes']);
  assert.deepEqual(res.rows[1], [1, 'Dr. Kerlin Sara Wilson', 'https://www.linkedin.com/in/kerlin', 'A & B <c> "d" bell']);
  assert.deepEqual(res.rows[3], [3, 'José García', 'https://www.linkedin.com/in/jos%C3%A9', '=1+1']);
  assert.equal(res.link, 'https://www.linkedin.com/in/kerlin');
  assert.equal(res.freeze, 'A2');
  assert.equal(res.filter, 'A1:D4');
});

test('crc32 and column names', () => {
  assert.equal(C.crc32(new TextEncoder().encode('hello')), 0x3610a686);
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(C.colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('lead search plan: designation x seniority x company x region, country fallback, cap', () => {
  const plan = C.buildLeadPlan({ titles: 'Head of Sales', seniority: ['vp'], companies: 'Zoho Corporation Pvt. Ltd.\nFreshworks', locations: 'Chennai', excludes: 'intern' });
  assert.deepEqual(plan.map(p => p.query), [
    'site:linkedin.com/in/ "Head of Sales" "Zoho" "Chennai" -"intern"',
    'site:linkedin.com/in/ "Head of Sales" "Freshworks" "Chennai" -"intern"',
    'site:linkedin.com/in/ "Vice President" "Zoho" "Chennai" -"intern"',
    'site:linkedin.com/in/ "Vice President" "Freshworks" "Chennai" -"intern"',
    'site:linkedin.com/in/ "VP" "Zoho" "Chennai" -"intern"',
    'site:linkedin.com/in/ "VP" "Freshworks" "Chennai" -"intern"',
  ]);
  assert.deepEqual(plan[1].meta, { title: 'Head of Sales', company: 'Freshworks', location: 'Chennai' });
  assert.deepEqual(C.buildLeadPlan({ titles: 'CEO', country: 'in' }).map(p => p.query), ['site:linkedin.com/in/ "CEO" "India"']);
  assert.deepEqual(C.buildLeadPlan({ functions: 'Sales', seniority: ['head'] }).map(p => p.query), ['site:linkedin.com/in/ "Head" "Sales"']);
  const many = Array.from({ length: 100 }, (_, i) => 'X' + i).join('\n');
  assert.equal(C.buildLeadPlan({ titles: many, companies: many }).length, 5000);
  assert.equal(C.buildLeadPlan({}).length, 0);
});

test('filter check: current company, past company, title, region, strict', () => {
  const now = { title: 'Priya Raman - Head of Sales - Zoho | LinkedIn', link: 'https://in.linkedin.com/in/priya-r',
    snippet: 'Head of Sales at Zoho · Experience: Zoho Corporation · Location: Chennai · 500+ connections' };
  const past = { title: 'Arun K - Product Manager - Infosys | LinkedIn', link: 'https://in.linkedin.com/in/arun',
    snippet: 'Product Manager at Infosys · Experience: Infosys · Previously Head of Sales at Zoho. Location: Bengaluru' };
  const unknownLoc = { title: 'Meera Iyer - VP Sales - Zoho | LinkedIn', link: 'https://in.linkedin.com/in/meera', snippet: '' };
  const f = { titles: 'Head of Sales', seniority: ['vp'], companies: 'Zoho Corporation Pvt. Ltd.', locations: 'Chennai', currentOnly: true };
  const a = C.checkLeadFilters(now, f);
  assert.deepEqual([a.label, a.pass, a.strictPass], ['Title ✓ · Company ✓ · Location ✓', true, true]);
  const b = C.checkLeadFilters(past, f);
  assert.equal(b.checks.company, false);
  assert.equal(b.pass, false);
  assert.equal(C.checkLeadFilters(past, Object.assign({}, f, { currentOnly: false })).checks.company, true);
  const c = C.checkLeadFilters(unknownLoc, f);
  assert.deepEqual([c.label, c.pass, c.strictPass], ['Title ✓ · Company ✓ · Location ?', true, false]);
  assert.equal(C.checkLeadFilters({ title: 'x', link: 'https://www.linkedin.com/company/zoho' }, f), null);
  const d = C.checkLeadFilters(now, { functions: 'Marketing' });
  assert.deepEqual([d.label, d.pass], ['Department ✗', false]);
  assert.equal(C.checkLeadFilters(now, { country: 'in' }).checks.location, false); // "Chennai" alone does not say India
  assert.equal(C.checkLeadFilters(Object.assign({}, now, { snippet: 'Location: Chennai, Tamil Nadu, India' }), { country: 'in' }).checks.location, true);
});

test('company search: queries, result parsing, size buckets', () => {
  assert.deepEqual(C.buildCompanyPlan({ keywords: 'roofing\nsolar', locations: 'Dallas', excludes: 'jobs' }).map(p => p.query), [
    'site:linkedin.com/company/ "roofing" "Dallas" -"jobs"', 'site:linkedin.com/company/ "solar" "Dallas" -"jobs"']);
  assert.deepEqual(C.buildCompanyPlan({ keywords: 'fintech', country: 'sg' }).map(p => p.query), ['site:linkedin.com/company/ "fintech" "Singapore"']);
  const co = C.parseCompanyResult({ title: 'ABC Roofing | LinkedIn', link: 'https://www.linkedin.com/company/abc-roofing/about/?x=1',
    snippet: 'ABC Roofing | 1,245 followers on LinkedIn. Quality roofs. | Industry: Construction · Company size: 11-50 employees · Headquarters: Dallas, Texas · Website: http://abcroofing.com' });
  assert.deepEqual([co.url, co.name, co.followers, co.size, co.sizeBucket, co.industry, co.hq, co.website],
    ['https://www.linkedin.com/company/abc-roofing', 'ABC Roofing', '1,245', '11-50', '11-50', 'Construction', 'Dallas, Texas', 'http://abcroofing.com']);
  assert.equal(C.parseCompanyResult({ title: 'Jane - X | LinkedIn', link: 'https://www.linkedin.com/in/jane' }), null);
  assert.equal(C.parseCompanyResult({ title: 'LinkedIn', link: 'https://uk.linkedin.com/company/acme-widgets' }).name, 'Acme Widgets');
  assert.deepEqual(['2-10', '10,001+', '1,234', '51-200 employees', ''].map(C.sizeBucket), ['1-10', '10001+', '1001-5000', '51-200', '']);
});
