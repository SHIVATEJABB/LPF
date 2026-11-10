/* LinkedIn Lead Finder - user interface. Uses LeadCore (core.js) for parsing, matching and exports. */
(function () {
  'use strict';

  const C = window.LeadCore;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- constants

  const GROUP = {
    Matched: 'matched', Found: 'matched', Manual: 'matched', Review: 'review',
    'Not found': 'notfound', Error: 'error', Pending: 'pending', Searching: 'searching',
  };
  const STATUS_LABEL = { Found: 'Found', Manual: 'Confirmed', Pending: 'Not searched' };

  const COLUMNS = [
    { key: 'no', label: 'No.', type: 'number', width: 6 },
    { key: 'name', label: 'Full Name', width: 28 },
    { key: 'firstName', label: 'First Name', width: 16 },
    { key: 'lastName', label: 'Last Name', width: 18 },
    { key: 'title', label: 'Job Title', width: 36 },
    { key: 'company', label: 'Company', width: 32 },
    { key: 'location', label: 'Location', width: 28 },
    { key: 'url', label: 'LinkedIn URL', type: 'url', width: 48 },
    { key: 'email', label: 'Email', width: 30 },
    { key: 'emailStatus', label: 'Email Status', width: 14 },
    { key: 'phone', label: 'Phone', width: 18 },
    { key: 'contactSource', label: 'Email/Phone Source', width: 16 },
    { key: 'website', label: 'Company Website', type: 'url', width: 32 },
    { key: 'companyUrl', label: 'Company LinkedIn URL', type: 'url', width: 45 },
    { key: 'companyIndustry', label: 'Company Industry', width: 24 },
    { key: 'companySize', label: 'Company Size', width: 18 },
    { key: 'companyHq', label: 'Company HQ', width: 24 },
    { key: 'liTitle', label: 'Title on LinkedIn', width: 36 },
    { key: 'liCompany', label: 'Company on LinkedIn', width: 30 },
    { key: 'statusText', label: 'Match Status', width: 14 },
    { key: 'confidence', label: 'Confidence %', type: 'number', width: 13 },
    { key: 'match', label: 'Filter Match', width: 34 },
    { key: 'degree', label: 'Connection', width: 11 },
    { key: 'resultTitle', label: 'Google Result Title', width: 45 },
    { key: 'snippet', label: 'Google Snippet', width: 60 },
    { key: 'query', label: 'Search Query Used', width: 55 },
    { key: 'source', label: 'Source', width: 16 },
    { key: 'note', label: 'Notes', width: 40 },
  ];
  const DEFAULT_EXPORT = ['no', 'name', 'firstName', 'lastName', 'title', 'company', 'location', 'url', 'email', 'emailStatus', 'phone',
    'website', 'companyUrl', 'companyIndustry', 'companySize', 'companyHq', 'liTitle', 'liCompany',
    'statusText', 'confidence', 'match', 'degree', 'query', 'source', 'note'];

  const COMPANY_COLUMNS = [
    { key: 'no', label: 'No.', type: 'number', width: 6 },
    { key: 'name', label: 'Company', width: 34 },
    { key: 'industry', label: 'Industry', width: 26 },
    { key: 'size', label: 'Company Size (employees)', width: 16 },
    { key: 'hq', label: 'Headquarters', width: 28 },
    { key: 'followers', label: 'LinkedIn Followers', width: 14 },
    { key: 'website', label: 'Website', type: 'url', width: 30 },
    { key: 'url', label: 'LinkedIn Page', type: 'url', width: 48 },
    { key: 'query', label: 'Search Query Used', width: 50 },
  ];

  const DEFAULTS = {
    maxLeads: 0, startRow: 1, resultsPerQuery: 10, maxQueriesPerLead: 2, onlyNew: true, findWebsite: true, findCompanyPage: true,
    findEmail: false, findPhone: false, contactReview: false,
    gl: '', hl: 'en', concurrency: 2, delayMs: 300, matchMin: 75, reviewMin: 50, cacheDays: 30,
    templates: C.DEFAULT_TEMPLATES.join('\n'),
    exportScope: 'all', exportColumns: DEFAULT_EXPORT.slice(),
    xray: { titles: '', functions: '', seniority: [], companies: '', locations: '', country: '', keywords: '', excludes: '',
      raw: '', target: 300, maxPages: 5, combineTitles: false, currentOnly: true, strict: false },
    company: { keywords: '', locations: '', country: '', excludes: '', raw: '', sizes: [], unknownSize: true, target: 100, maxPages: 5 },
  };
  const NESTED = ['xray', 'company'];

  // ---------------------------------------------------------------- state

  const state = { rows: [], companies: [], companyInfo: {}, contactJobs: [], nextId: 1, settings: clone(DEFAULTS) };
  const view = { filter: 'all', search: '', page: 1, pageSize: 100, open: new Set(), cpage: 1 };
  const run = newRun();
  let server = { ok: false, provider: '', keys: {} };

  function newRun() {
    return { active: false, paused: false, stop: false, kind: '', total: 0, done: 0, credits: 0, cached: 0,
      errors: 0, consecutiveErrors: 0, started: 0, fatal: '' };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function int(v, def, min, max) {
    const n = Math.floor(Number(v));
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }
  function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function safeHref(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }

  function mergeSettings(saved) {
    const s = clone(DEFAULTS);
    if (saved && typeof saved === 'object') {
      const same = (a, b) => (Array.isArray(b) ? Array.isArray(a) : a !== undefined && typeof a === typeof b);
      Object.keys(DEFAULTS).forEach(k => {
        if (NESTED.includes(k)) return;
        if (same(saved[k], DEFAULTS[k])) s[k] = saved[k];
      });
      NESTED.forEach(n => {
        if (!saved[n] || typeof saved[n] !== 'object') return;
        Object.keys(DEFAULTS[n]).forEach(k => { if (same(saved[n][k], DEFAULTS[n][k])) s[n][k] = saved[n][k]; });
      });
      if (Array.isArray(saved.exportColumns)) s.exportColumns = saved.exportColumns.filter(k => COLUMNS.some(c => c.key === k));
    }
    if (!s.exportColumns.length) s.exportColumns = DEFAULT_EXPORT.slice();
    return s;
  }

  const ROW_FIELDS = ['name', 'firstName', 'lastName', 'title', 'company', 'location', 'degree', 'source', 'url',
    'status', 'resultTitle', 'snippet', 'query', 'note', 'error', 'match', 'email',
    'liTitle', 'liCompany', 'liLocation', 'companyUrl', 'website', 'companyIndustry', 'companySize', 'companyHq',
    'phone', 'emailStatus', 'contactSource', 'contactTried'];
  const COMPANY_FIELDS = ['name', 'url', 'industry', 'size', 'sizeBucket', 'hq', 'followers', 'website', 'snippet', 'query'];

  function sanitizeCompany(c, id) {
    const out = { id, selected: c.selected !== false };
    COMPANY_FIELDS.forEach(k => { out[k] = c[k] == null ? '' : String(c[k]); });
    return out;
  }

  function sanitizeRow(r, id) {
    const row = { id };
    ROW_FIELDS.forEach(k => { row[k] = r[k] == null ? '' : String(r[k]); });
    row.confidence = int(r.confidence, 0, 0, 100);
    if (!GROUP[row.status] || row.status === 'Searching') row.status = row.url ? 'Manual' : 'Pending';
    row.candidates = Array.isArray(r.candidates) ? r.candidates.slice(0, 5).map(c => ({
      url: String(c.url || ''), name: String(c.name || ''), resultTitle: String(c.resultTitle || ''),
      snippet: String(c.snippet || ''), confidence: int(c.confidence, 0, 0, 100), verdict: String(c.verdict || ''),
      why: String(c.why || ''), query: String(c.query || ''),
      title: String(c.title || ''), company: String(c.company || ''), location: String(c.location || ''),
    })) : [];
    if (!row.source) row.source = 'Sales Navigator';
    return row;
  }

  function newRow(lead, source, extra) {
    const n = C.splitName(lead.name);
    return Object.assign(sanitizeRow({
      name: lead.name, firstName: lead.firstName || n.firstName, lastName: lead.lastName || n.lastName,
      title: lead.title, company: lead.company, location: lead.location, degree: lead.degree, email: lead.email, source,
      url: lead.url || '', status: lead.url ? 'Manual' : 'Pending',
    }, state.nextId++), extra || {});
  }

  // ---------------------------------------------------------------- server API

  async function api(path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
    try {
      const opts = body === undefined
        ? { method: 'GET', signal: ctrl.signal, cache: 'no-store' }
        : { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'X-LLF': '1' }, body: JSON.stringify(body) };
      const res = await fetch(path, opts);
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!data || typeof data !== 'object') return { ok: false, error: 'The local server answered HTTP ' + res.status + ' with no data.' };
      if (!res.ok && data.ok === undefined) data.ok = false;
      return data;
    } catch (e) {
      return {
        ok: false, offline: true,
        error: e && e.name === 'AbortError'
          ? 'The local server did not answer in time.'
          : 'Cannot reach the local server. Make sure the black server window is still open, then reload this page.',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshServer() {
    if (location.protocol === 'file:') {
      server = { ok: false };
      showBanner('error', 'You opened the file directly. Searching needs the local server: double-click START_HERE.py '
        + '(or start_mac_linux.sh) and use the page that opens at http://127.0.0.1:8765. Pasting and exporting still work here.');
      renderServer();
      return;
    }
    const h = await api('/api/health', undefined, 8000);
    server = h && h.ok ? h : { ok: false, error: h && h.error };
    renderServer();
  }

  function providerName(p) { return { serpapi: 'SerpApi', serper: 'Serper', mock: 'Mock mode' }[p] || p; }
  function keyReady() { return server.ok && (server.provider === 'mock' || (server.keys[server.provider] || {}).set); }

  function renderServer() {
    const chip = $('serverStatus');
    if (!server.ok) {
      chip.className = 'chip bad';
      chip.textContent = 'Server not connected';
    } else if (server.provider === 'mock') {
      chip.className = 'chip warn';
      chip.textContent = 'Mock mode – fake results, no credits';
    } else if (!keyReady()) {
      chip.className = 'chip warn';
      chip.textContent = providerName(server.provider) + ' – no API key';
    } else {
      chip.className = 'chip ok';
      chip.textContent = providerName(server.provider) + ' – key saved';
    }
    if (server.ok) {
      $('provider').value = server.provider;
      const k = server.keys[server.provider];
      $('keyRow').hidden = server.provider === 'mock';
      $('keyState').textContent = k && k.set ? '(saved: ' + k.masked + (k.fromEnv ? ', from environment variable' : '') + ')' : '(not saved yet)';
      const cp = server.contactProvider || 'hunter';
      const ck = server.keys[cp];
      $('contactProvider').value = cp;
      $('contactKeyRow').hidden = cp === 'mock';
      $('contactKeyState').textContent = ck && ck.set ? '(saved: ' + ck.masked + (ck.fromEnv ? ', from environment variable' : '') + ')' : '(not saved yet)';
    }
    renderContactNote();
  }

  const CONTACT_NAMES = { hunter: 'Hunter', apollo: 'Apollo', fullenrich: 'FullEnrich', mock: 'Mock mode' };

  // What each email/phone provider can find through this tool.
  function contactCan(provider) {
    return { email: true, phone: provider === 'fullenrich' || provider === 'mock' || provider === 'hunter' };
  }

  function renderContactNote() {
    const cp = server.contactProvider || 'hunter';
    let note = 'Provider: ' + CONTACT_NAMES[cp] + ' (change it in Settings).';
    if (cp === 'hunter') note += ' Hunter finds emails; phone numbers only when they are public.';
    if (cp === 'apollo') note += ' Apollo finds emails here; for phone numbers choose FullEnrich.';
    if (cp === 'mock') note += ' Mock mode: made-up emails and numbers, no credits.';
    if (cp !== 'mock' && !(server.keys && server.keys[cp] && server.keys[cp].set)) note += ' No API key saved yet.';
    $('contactNote').textContent = note;
  }

  // ---------------------------------------------------------------- persistence

  // Throttled (not debounced) so progress is saved regularly during long runs.
  let saveTimer = null, saving = false, saveAgain = false;
  function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 2000);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (saving) { saveAgain = true; return; }
    saving = true;
    try {
      try { localStorage.setItem('llf-settings', JSON.stringify(state.settings)); } catch (e) { /* storage unavailable */ }
      const payload = {
        version: 2, savedAt: Date.now(), nextId: state.nextId, settings: state.settings, companies: state.companies,
        companyInfo: state.companyInfo, contactJobs: state.contactJobs,
        rows: state.rows.map(r => Object.assign({}, r, { status: r.status === 'Searching' ? 'Pending' : r.status })),
      };
      if (server.ok) {
        const res = await api('/api/state', payload);
        if (!res.ok) showBanner('warn', 'Could not save your sheet: ' + res.error);
      } else {
        try { localStorage.setItem('llf-state', JSON.stringify(payload)); } catch (e) { /* too big or blocked */ }
      }
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; scheduleSave(); }
    }
  }

  async function loadState() {
    let saved = null;
    if (server.ok) {
      const r = await api('/api/state');
      if (r && Array.isArray(r.rows)) saved = r;
    }
    if (!saved) {
      try { saved = JSON.parse(localStorage.getItem('llf-state') || 'null'); } catch (e) { saved = null; }
    }
    let settings = saved && saved.settings;
    if (!settings) {
      try { settings = JSON.parse(localStorage.getItem('llf-settings') || 'null'); } catch (e) { settings = null; }
    }
    state.settings = mergeSettings(settings);
    if (saved && Array.isArray(saved.rows)) {
      state.rows = [];
      state.nextId = 1;
      saved.rows.forEach(r => { if (r && r.name) state.rows.push(sanitizeRow(r, state.nextId++)); });
    }
    if (saved && saved.companyInfo && typeof saved.companyInfo === 'object' && !Array.isArray(saved.companyInfo)) {
      state.companyInfo = {};
      Object.keys(saved.companyInfo).forEach(k => {
        const v = saved.companyInfo[k];
        if (!v || typeof v !== 'object') return;
        const info = {};
        ['name', 'website', 'websiteHow', 'pageUrl', 'pageName', 'industry', 'size', 'hq', 'followers'].forEach(f => { info[f] = v[f] == null ? '' : String(v[f]); });
        info.webDone = !!v.webDone;
        info.pageDone = !!v.pageDone;
        state.companyInfo[k] = info;
      });
    }
    if (saved && Array.isArray(saved.contactJobs)) {
      state.contactJobs = saved.contactJobs.filter(j => j && typeof j.job === 'string' && Array.isArray(j.ids))
        .map(j => ({ job: j.job, ids: j.ids.map(String), want: { email: !!(j.want && j.want.email), phone: !!(j.want && j.want.phone) }, started: Number(j.started) || 0 }));
    }
    if (saved && Array.isArray(saved.companies)) {
      state.companies = saved.companies.filter(c => c && c.name && c.url).map(c => sanitizeCompany(c, state.nextId++));
    }
  }

  // ---------------------------------------------------------------- messages

  function showBanner(kind, text) {
    const b = $('banner');
    b.className = 'banner ' + (kind || '');
    $('bannerText').textContent = text;
    b.hidden = false;
  }
  function hideBanner() { $('banner').hidden = true; }

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function setMsg(id, text, kind) {
    const el = $(id);
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // ---------------------------------------------------------------- settings form

  const NUMBER_FIELDS = [
    ['maxLeads', 'maxLeads', 0, 0, 1e9], ['startRow', 'startRow', 1, 1, 1e9],
    ['resultsPerQuery', 'resultsPerQuery', 10, 1, 100], ['maxQueries', 'maxQueriesPerLead', 2, 1, 5],
    ['concurrency', 'concurrency', 2, 1, 5], ['delayMs', 'delayMs', 300, 0, 60000],
    ['matchMin', 'matchMin', 75, 1, 100], ['reviewMin', 'reviewMin', 50, 1, 100], ['cacheDays', 'cacheDays', 30, 0, 365],
  ];
  // [element id, settings group, key]
  const TEXT_FIELDS = [
    ['xTitles', 'xray', 'titles'], ['xFunctions', 'xray', 'functions'], ['xCompanies', 'xray', 'companies'],
    ['xLocations', 'xray', 'locations'], ['xKeywords', 'xray', 'keywords'], ['xExcludes', 'xray', 'excludes'],
    ['xRaw', 'xray', 'raw'], ['xCountry', 'xray', 'country'],
    ['cKeywords', 'company', 'keywords'], ['cLocations', 'company', 'locations'], ['cExcludes', 'company', 'excludes'],
    ['cRaw', 'company', 'raw'], ['cCountry', 'company', 'country'],
  ];
  const GROUP_NUM = [['xTarget', 'xray', 'target', 300, 1, 1e6], ['xPages', 'xray', 'maxPages', 5, 1, 10],
    ['cTarget', 'company', 'target', 100, 1, 1e5], ['cPages', 'company', 'maxPages', 5, 1, 10]];
  const GROUP_CHECK = [['xCombine', 'xray', 'combineTitles'], ['xCurrentOnly', 'xray', 'currentOnly'],
    ['xStrict', 'xray', 'strict'], ['cUnknownSize', 'company', 'unknownSize']];
  // [container id, settings group, key] for groups of checkboxes stored as a list
  const MULTI_CHECK = [['xSeniority', 'xray', 'seniority'], ['cSizes', 'company', 'sizes']];

  function buildStaticOptions() {
    document.querySelectorAll('select.country').forEach(sel => {
      sel.appendChild(el('option', { value: '', text: 'Any country' }));
      C.COUNTRIES.forEach(([code, name]) => sel.appendChild(el('option', { value: code, text: name })));
    });
    C.SIZE_BUCKETS.forEach(([k]) => {
      $('cSizes').appendChild(el('label', { className: 'check' }, [el('input', { type: 'checkbox', 'data-k': k }), ' ' + k]));
    });
  }

  function fillForm() {
    const s = state.settings;
    NUMBER_FIELDS.forEach(([id, key]) => { $(id).value = s[key]; });
    $('onlyNew').checked = !!s.onlyNew;
    $('findWebsite').checked = !!s.findWebsite;
    $('findEmail').checked = !!s.findEmail;
    $('findPhone').checked = !!s.findPhone;
    $('contactReview').checked = !!s.contactReview;
    $('findCompanyPage').checked = !!s.findCompanyPage;
    $('gl').value = s.gl;
    $('hl').value = s.hl;
    $('templates').value = s.templates;
    $('exportScope').value = s.exportScope;
    TEXT_FIELDS.forEach(([id, g, key]) => { $(id).value = s[g][key]; });
    GROUP_NUM.forEach(([id, g, key]) => { $(id).value = s[g][key]; });
    GROUP_CHECK.forEach(([id, g, key]) => { $(id).checked = !!s[g][key]; });
    MULTI_CHECK.forEach(([id, g, key]) => {
      $(id).querySelectorAll('input[data-k]').forEach(cb => { cb.checked = s[g][key].includes(cb.getAttribute('data-k')); });
    });
  }

  function bindForm() {
    NUMBER_FIELDS.forEach(([id, key, def, min, max]) => {
      $(id).addEventListener('change', () => {
        state.settings[key] = int($(id).value, def, min, max);
        $(id).value = state.settings[key];
        if (state.settings.reviewMin > state.settings.matchMin) {
          state.settings.reviewMin = state.settings.matchMin;
          $('reviewMin').value = state.settings.reviewMin;
        }
        updateEstimate();
        scheduleSave();
      });
    });
    $('onlyNew').addEventListener('change', () => { state.settings.onlyNew = $('onlyNew').checked; updateEstimate(); scheduleSave(); });
    ['findWebsite', 'findCompanyPage', 'findEmail', 'findPhone', 'contactReview'].forEach(id => $(id).addEventListener('change', () => {
      state.settings[id] = $(id).checked;
      updateEstimate();
      scheduleSave();
    }));
    $('gl').addEventListener('change', () => { state.settings.gl = $('gl').value.trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 2); $('gl').value = state.settings.gl; scheduleSave(); });
    $('hl').addEventListener('change', () => { state.settings.hl = $('hl').value.trim().replace(/[^a-zA-Z-]/g, '').slice(0, 8); $('hl').value = state.settings.hl; scheduleSave(); });
    $('templates').addEventListener('change', () => {
      const t = $('templates').value.split('\n').map(x => x.trim()).filter(Boolean).join('\n');
      state.settings.templates = t || DEFAULTS.templates;
      $('templates').value = state.settings.templates;
      updateEstimate();
      scheduleSave();
    });
    $('resetTemplates').addEventListener('click', () => {
      state.settings.templates = DEFAULTS.templates;
      $('templates').value = DEFAULTS.templates;
      scheduleSave();
      toast('Query templates reset.');
    });
    $('exportScope').addEventListener('change', () => { state.settings.exportScope = $('exportScope').value; scheduleSave(); });
    TEXT_FIELDS.forEach(([id, g, key]) => $(id).addEventListener('change', () => { state.settings[g][key] = $(id).value; scheduleSave(); }));
    GROUP_NUM.forEach(([id, g, key, def, min, max]) => $(id).addEventListener('change', () => {
      state.settings[g][key] = int($(id).value, def, min, max);
      $(id).value = state.settings[g][key];
      scheduleSave();
    }));
    GROUP_CHECK.forEach(([id, g, key]) => $(id).addEventListener('change', () => { state.settings[g][key] = $(id).checked; scheduleSave(); }));
    MULTI_CHECK.forEach(([id, g, key]) => $(id).addEventListener('change', () => {
      state.settings[g][key] = Array.from($(id).querySelectorAll('input[data-k]')).filter(cb => cb.checked).map(cb => cb.getAttribute('data-k'));
      scheduleSave();
    }));
  }

  // ---------------------------------------------------------------- settings dialog

  function openSettings() {
    const d = $('settings');
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  }

  async function changeProvider() {
    const p = $('provider').value;
    const res = await api('/api/config', { provider: p });
    if (!res.ok) { setMsg('testMsg', res.error, 'bad'); return; }
    server = Object.assign({}, server, res, { ok: true });
    setMsg('testMsg', p === 'mock' ? 'Mock mode on: results are fake and cost nothing.' : '', 'ok');
    renderServer();
  }

  async function saveKey() {
    const key = $('apiKey').value.trim();
    if (!key) { setMsg('testMsg', 'Paste your API key first.', 'bad'); return; }
    const res = await api('/api/config', { key, keyProvider: $('provider').value });
    if (!res.ok) { setMsg('testMsg', res.error, 'bad'); return; }
    $('apiKey').value = '';
    server = Object.assign({}, server, res, { ok: true });
    renderServer();
    setMsg('testMsg', 'Key saved. Click “Test connection” to check it.', 'ok');
  }

  async function changeContactProvider() {
    const res = await api('/api/config', { contactProvider: $('contactProvider').value });
    if (!res.ok) { setMsg('contactMsg', res.error, 'bad'); return; }
    server = Object.assign({}, server, res, { ok: true });
    setMsg('contactMsg', $('contactProvider').value === 'mock' ? 'Mock mode on: emails and numbers are made up and cost nothing.' : '', 'ok');
    renderServer();
    updateEstimate();
  }

  async function saveContactKey() {
    const key = $('contactKey').value.trim();
    if (!key) { setMsg('contactMsg', 'Paste your API key first.', 'bad'); return; }
    const res = await api('/api/config', { key, keyProvider: $('contactProvider').value });
    if (!res.ok) { setMsg('contactMsg', res.error, 'bad'); return; }
    $('contactKey').value = '';
    server = Object.assign({}, server, res, { ok: true });
    renderServer();
    setMsg('contactMsg', 'Key saved. Click “Test connection” to check it.', 'ok');
  }

  async function testContactKey() {
    if ($('contactKey').value.trim()) await saveContactKey();
    setMsg('contactMsg', 'Testing…');
    const res = await api('/api/contact/test', {});
    setMsg('contactMsg', res.message || res.error || 'No answer.', res.ok ? 'ok' : 'bad');
  }

  async function testKey() {
    if ($('apiKey').value.trim()) await saveKey();
    setMsg('testMsg', 'Testing…');
    const res = await api('/api/test', {});
    setMsg('testMsg', res.message || res.error || 'No answer.', res.ok ? 'ok' : 'bad');
  }

  // ---------------------------------------------------------------- adding leads

  function addLeads(leads, source) {
    const added = addLeadsRaw(leads, source);
    state.rows.forEach(r => { if (!r.website && !r.companyUrl) applyCompanyInfo(r); });
    return added;
  }

  function addLeadsRaw(leads, source) {
    const keys = new Set(state.rows.map(r => C.leadKey(r)));
    const urls = new Set(state.rows.map(r => r.url).filter(Boolean));
    let added = 0, dup = 0;
    leads.forEach(l => {
      const k = C.leadKey(l);
      if (keys.has(k) || (l.url && urls.has(l.url))) { dup++; return; }
      keys.add(k);
      if (l.url) urls.add(l.url);
      state.rows.push(newRow(l, source));
      added++;
    });
    return { added, dup };
  }

  let pendingCompanies = [];

  function parsePaste() {
    const text = $('pasteBox').value;
    if (!text.trim()) { setMsg('parseMsg', 'Paste something first.', 'bad'); return; }
    const res = C.parseLeads(text);
    if (!res.leads.length) {
      setMsg('parseMsg', 'No people found in that text. Copy the whole Sales Navigator page (Ctrl+A, Ctrl+C) and try again.', 'bad');
      return;
    }
    const r = addLeads(res.leads, res.mode === 'sales-navigator' || res.mode === 'blocks' ? 'Sales Navigator' : 'Import');
    const noCompany = res.leads.filter(l => !l.company).length;
    const parts = ['Added ' + plural(r.added, 'new lead')];
    if (r.dup + res.duplicates) parts.push(plural(r.dup + res.duplicates, 'duplicate') + ' skipped');
    if (noCompany) parts.push(noCompany + ' without a company');
    if (res.skipped) parts.push(res.skipped + ' empty or title-only ' + (res.skipped === 1 ? 'row' : 'rows') + ' skipped');
    setMsg('parseMsg', parts.join(' · ') + '. Paste more or start the search.', 'ok');
    pendingCompanies = res.companiesWithoutPeople || [];
    $('noNameBtn').hidden = !pendingCompanies.length;
    $('noNameBtn').textContent = pendingCompanies.length + (pendingCompanies.length === 1 ? ' company has' : ' companies have')
      + ' no contact name – find decision makers there →';
    $('pasteBox').value = '';
    view.filter = 'all';
    view.page = Math.max(1, Math.ceil(state.rows.length / view.pageSize));
    renderAll();
    scheduleSave();
  }

  function importFile(ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('pasteBox').value = String(reader.result || '').replace(/^﻿/, '');
      ev.target.value = '';
      parsePaste();
    };
    reader.onerror = () => setMsg('parseMsg', 'Could not read that file.', 'bad');
    reader.readAsText(f);
  }

  function demoText() {
    const people = [
      ['Jordan Avery', 'Second', 'Head of Operations', 'Northwind Roofing LLC', 'Dallas, Texas, United States'],
      ['Priya Raman', 'Third', 'Chief Executive Officer', 'Bluepeak Health Pvt. Ltd.', 'Chennai, Tamil Nadu, India'],
      ['Dr. Samuel Okafor', 'Second', 'Founder & Director', 'Okafor Analytics', 'Greater London'],
      ['Meera K S', 'Third', 'Business Head', 'Sunrise Logistics Private Limited', 'Bengaluru, Karnataka, India'],
      ['Lucas Moreau', 'Second', 'VP Sales', '', 'Paris, Île-de-France, France'],
      ['Ana Torres', 'Third', 'General Manager', 'Torres Building Supply | TBS', 'Austin, Texas, United States'],
    ];
    const out = ['Name\tAccount\tGeography\tNotes Tooltip', 'Outreach activity\tDate added\tActions', ''];
    people.forEach(([n, deg, title, company, loc]) => {
      out.push('Select ' + n, n, n + '’s profile picture', n, deg + '-degree connection', deg === 'Second' ? '2nd' : '3rd', '',
        '1 List', 'Saved Badge', title);
      if (company) out.push(company); else out.push('', 'Add Account', 'Open the account matching modal to add an account');
      out.push(loc + '\t', '', 'Add note', 'No activity', '8/27/2026\t', '', '');
    });
    return out.join('\n');
  }

  // ---------------------------------------------------------------- search runs

  function thresholds() { return { matchMin: state.settings.matchMin, reviewMin: state.settings.reviewMin }; }

  function findTargets() {
    const s = state.settings;
    let list = state.rows.slice(Math.max(1, s.startRow) - 1).filter(r => r.status !== 'Found' && r.status !== 'Manual');
    if (s.onlyNew) list = list.filter(r => r.status === 'Pending' || r.status === 'Error');
    if (s.maxLeads > 0) list = list.slice(0, s.maxLeads);
    return list;
  }

  function updateEstimate() {
    if (run.active) return;
    const n = findTargets().length;
    const pages = Math.ceil(state.settings.resultsPerQuery / 10);
    const maxQ = Math.min(state.settings.maxQueriesPerLead, state.settings.templates.split('\n').filter(Boolean).length);
    if (!state.rows.length) { setMsg('estimate', ''); return; }
    if (!n) { setMsg('estimate', 'Nothing to search with these settings (all rows in range are done). Untick “Only search rows…” to search again.'); return; }
    const cos = companiesToLookUp(findTargets());
    const coCredits = cos.length * companySearchesEach();
    setMsg('estimate', plural(n, 'lead') + ' will be searched · about ' + n * pages + '–' + n * pages * maxQ
      + ' Google searches (credits)' + contactEstimateText(findTargets()) + (coCredits ? ' + up to ' + coCredits + ' for ' + plural(cos.length, 'company').replace('companys', 'companies') + ' (website, LinkedIn page)' : '')
      + '. Cached repeats are free.');
  }

  async function waitIfPaused() {
    while (run.paused && !run.stop) await sleep(200);
  }

  async function doSearch(query, page, mode, extra) {
    const s = state.settings;
    const x = extra || {};
    const resp = await api('/api/search', { query, page, mode, gl: x.gl || s.gl, hl: s.hl, cacheDays: s.cacheDays, meta: x.meta || {} });
    if (resp.ok) {
      if (!Array.isArray(resp.results)) resp.results = [];
      if (resp.cached) run.cached++;
      else if (resp.provider !== 'mock') run.credits++;
      run.consecutiveErrors = 0;
      if (!resp.cached && s.delayMs > 0) await sleep(s.delayMs);
    } else {
      run.errors++;
      run.consecutiveErrors++;
      if (resp.fatal || resp.offline) {
        run.stop = true;
        run.fatal = resp.error;
      } else if (run.consecutiveErrors >= 5 && !run.paused) {
        run.paused = true;
        showBanner('error', '5 searches failed in a row, so the search is paused. Last error: ' + resp.error
          + ' Fix the problem, then press Resume.');
        renderRunButtons();
      }
    }
    return resp;
  }

  async function runPool(items, worker, concurrency) {
    let i = 0;
    async function next() {
      while (!run.stop && i < items.length) {
        const item = items[i++];
        await worker(item);
      }
    }
    const n = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: n }, next));
  }

  function storeCandidates(row, ranked) {
    row.candidates = ranked.slice(0, 5).map(c => ({
      url: c.url, name: c.name, resultTitle: trunc(c.resultTitle, 200), snippet: trunc(c.snippet, 300),
      confidence: c.confidence, verdict: c.verdict, why: c.why, query: c.query || '',
      title: c.title || c.headline || '', company: c.company || '', location: c.location || '',
    }));
  }

  function fillBlanksFromLinkedIn(row) {
    if (!row.title && row.liTitle) row.title = row.liTitle;
    if (!row.company && row.liCompany) { row.company = row.liCompany; applyCompanyInfo(row); }
    if (!row.location && row.liLocation) row.location = row.liLocation;
  }

  function applyBest(row, ranked, lastQuery) {
    storeCandidates(row, ranked);
    const best = ranked[0];
    if (best && best.verdict !== 'No match') {
      row.url = best.url;
      row.status = best.verdict;
      row.confidence = best.confidence;
      row.resultTitle = trunc(best.resultTitle, 300);
      row.snippet = trunc(best.snippet, 500);
      row.query = best.query || lastQuery;
      row.note = (best.verdict === 'Review' ? 'Please check: ' : '') + best.why;
      row.liTitle = best.title || best.headline || '';
      row.liCompany = best.company || '';
      row.liLocation = best.location || '';
      // Only a sure match may fill in missing details; a Review row does it when you confirm it.
      if (best.verdict === 'Matched') fillBlanksFromLinkedIn(row);
    } else {
      row.url = '';
      row.status = 'Not found';
      row.confidence = best ? best.confidence : 0;
      row.resultTitle = best ? trunc(best.resultTitle, 300) : '';
      row.snippet = '';
      row.query = lastQuery;
      row.note = best ? 'Closest result was too weak (' + best.why + ')' : 'No LinkedIn profile in the Google results';
    }
  }

  async function processRow(row) {
    const s = state.settings;
    const queries = C.buildFindQueries(row, s.templates).slice(0, s.maxQueriesPerLead);
    const prevStatus = row.status;
    row.error = '';
    if (!queries.length) {
      row.status = 'Error';
      row.error = 'Cannot build a search: the name is missing or a template field is empty.';
      return;
    }
    row.status = 'Searching';
    scheduleRender();
    const pages = Math.max(1, Math.ceil(s.resultsPerQuery / 10));
    const cands = new Map();
    let lastQuery = queries[0];
    let failure = '';
    let searched = false;
    outer:
    for (const q of queries) {
      lastQuery = q;
      for (let page = 1; page <= pages; page++) {
        await waitIfPaused();
        if (run.stop) break outer;
        const resp = await doSearch(q, page, 'find');
        if (!resp.ok) { failure = resp.error || 'Search failed'; break outer; }
        searched = true;
        const results = resp.results.slice(0, s.resultsPerQuery - (page - 1) * 10);
        C.evaluateResults(row, results, thresholds()).forEach(c => {
          c.query = q;
          const prev = cands.get(c.url);
          if (!prev || c.confidence > prev.confidence) cands.set(c.url, c);
        });
        const top = C.rankCandidates(Array.from(cands.values()))[0];
        if (top && top.verdict === 'Matched') break outer;
        if (!resp.hasMore || !resp.results.length) break;
      }
    }
    if (!searched) {
      if (prevStatus === 'Matched' || prevStatus === 'Review' || prevStatus === 'Not found') {
        // Keep the earlier result; only say that the new search failed.
        row.status = prevStatus;
        if (failure) row.note = trunc('Search again failed: ' + failure + (row.note ? ' · ' + row.note : ''), 300);
        return;
      }
      row.status = failure ? 'Error' : 'Pending';
      row.error = failure;
      row.query = lastQuery;
      return;
    }
    applyBest(row, C.rankCandidates(Array.from(cands.values())), lastQuery);
    if (failure) row.note = trunc((row.note ? row.note + ' · ' : '') + 'a backup search failed: ' + failure, 300);
  }

  function markDuplicateUrls() {
    const byUrl = new Map();
    state.rows.forEach(r => {
      if (!r.url) return;
      if (!byUrl.has(r.url)) byUrl.set(r.url, []);
      byUrl.get(r.url).push(r);
    });
    byUrl.forEach(list => {
      if (list.length < 2) return;
      list.forEach(r => {
        const others = list.filter(o => o !== r).map(o => '#' + (state.rows.indexOf(o) + 1));
        const note = 'Same LinkedIn URL as row ' + others.join(', ');
        if (!r.note.includes('Same LinkedIn URL')) r.note = trunc((r.note ? r.note + ' · ' : '') + note, 300);
        if (r.status === 'Matched') r.status = 'Review';
      });
    });
  }

  function preflight() {
    if (run.active) return false;
    if (!server.ok) {
      showBanner('error', 'The local server is not connected. Start START_HERE.py (or start_mac_linux.sh) and reload this page.');
      return false;
    }
    if (!keyReady()) {
      openSettings();
      setMsg('testMsg', 'Save your ' + providerName(server.provider) + ' API key first, or choose Mock test mode.', 'bad');
      return false;
    }
    return true;
  }

  function startRun(kind, total, label) {
    Object.assign(run, newRun(), { active: true, kind, total, started: Date.now(), label });
    hideBanner();
    renderRunButtons();
    renderProgress();
  }

  async function finishRun(summary) {
    const stoppedByUser = run.stop && !run.fatal;
    run.active = false;
    run.paused = false;
    markDuplicateUrls();
    renderRunButtons();
    renderAll();
    await saveNow();
    const cost = run.credits + ' search credit' + (run.credits === 1 ? '' : 's') + ' used'
      + (run.cached ? ', ' + run.cached + ' answered from cache' : '')
      + (run.contactCalls ? ', ' + run.contactCalls + ' email/phone ' + (run.contactCalls === 1 ? 'request' : 'requests') : '');
    if (run.fatal) {
      showBanner('error', 'Search stopped: ' + run.fatal + ' (' + cost + '.) Nothing else was searched, so no more credits were spent.');
    } else {
      showBanner(stoppedByUser ? 'warn' : 'ok', (stoppedByUser ? 'Stopped. ' : 'Done. ') + summary + ' ' + cost + '.');
    }
    setMsg('progressText', (run.fatal ? 'Stopped by an error. ' : stoppedByUser ? 'Stopped. ' : 'Finished. ') + summary);
    updateEstimate();
  }

  async function runFind(rows) {
    if (!preflight()) return;
    const targets = rows || findTargets();
    if (!targets.length) { toast(state.rows.length ? 'Nothing to search with these settings.' : 'Add some leads first.'); return; }
    const s = state.settings;
    const coCount = rows ? 0 : companiesToLookUp(targets).length;
    const maxCredits = targets.length * Math.ceil(s.resultsPerQuery / 10) * s.maxQueriesPerLead + coCount * companySearchesEach();
    if (server.provider !== 'mock' && maxCredits > 50 && !rows
      && !window.confirm('Search ' + plural(targets.length, 'lead')
        + (coCount ? ' and look up ' + plural(coCount, 'company').replace('companys', 'companies') : '')
        + '? This can use up to ' + maxCredits + ' search credits (usually far fewer). Searches already cached are free.'
        + (contactWants().any ? ' Email/phone lookups for the matched leads use your ' + CONTACT_NAMES[server.contactProvider || 'hunter'] + ' credits.' : ''))) return;
    if (!rows && contactWants().any && !contactReady(true)) return;
    startRun('find', targets.length);
    await runPool(targets, async row => {
      await processRow(row);
      run.done++;
      renderProgress();
      scheduleRender();
      scheduleSave();
    }, s.concurrency);
    let coSummary = '';
    if (!rows && !run.stop && companySearchesEach()) coSummary = await lookUpCompanies(companiesToLookUp(targets));
    let contactSummary = '';
    if (!rows && !run.stop && contactWants().any) contactSummary = await lookUpContacts(contactTargets(targets));
    const c = countStatuses(targets);
    await finishRun(c.matched + ' matched, ' + c.review + ' to review, ' + c.notfound + ' not found'
      + (c.error ? ', ' + c.error + ' errors' : '') + '.' + (coSummary ? ' ' + coSummary : '') + (contactSummary ? ' ' + contactSummary : ''));
  }

  // ---------------------------------------------------------------- emails & phone numbers

  function contactWants() {
    const s = state.settings;
    const can = contactCan(server.contactProvider || 'hunter');
    const want = { email: !!s.findEmail && can.email, phone: !!s.findPhone && can.phone };
    want.any = want.email || want.phone;
    return want;
  }

  function contactReady(openIfNot) {
    const cp = server.contactProvider || 'hunter';
    if (!server.ok) {
      showBanner('error', 'The local server is not connected. Start START_HERE.py and reload this page.');
      return false;
    }
    if (cp === 'mock' || (server.keys[cp] && server.keys[cp].set)) return true;
    if (openIfNot) {
      openSettings();
      setMsg('contactMsg', 'Save your ' + CONTACT_NAMES[cp] + ' API key first (Email & phone finder), or choose Mock test mode.', 'bad');
    }
    return false;
  }

  function contactTried(r, field) {
    return (' ' + r.contactTried + ' ').includes(' ' + (server.contactProvider || 'hunter') + ':' + field + ' ');
  }

  function markTried(r, field) {
    if (!contactTried(r, field)) r.contactTried = C.normSpace(r.contactTried + ' ' + (server.contactProvider || 'hunter') + ':' + field);
  }

  // Matched leads (and Review if ticked) that still need an email or phone from this provider.
  function contactTargets(rows) {
    const want = contactWants();
    if (!want.any) return [];
    const pending = new Set();
    state.contactJobs.forEach(j => j.ids.forEach(id => pending.add(id)));
    const ok = { Matched: 1, Manual: 1, Found: 1, Review: state.settings.contactReview ? 1 : 0 };
    return rows.filter(r => ok[r.status] && !pending.has(String(r.id))
      && ((want.email && !r.email && !contactTried(r, 'email')) || (want.phone && !r.phone && !contactTried(r, 'phone'))));
  }

  function contactEstimateText(rows) {
    const want = contactWants();
    if (!want.any) return '';
    return ' + email/phone lookups for the leads that get matched (' + CONTACT_NAMES[server.contactProvider || 'hunter'] + ' credits)';
  }

  function personFor(r) {
    const clean = C.cleanPersonName(r.name);
    const tokens = clean.split(' ').filter(t => t && !/^\p{L}\.?$/u.test(t));
    const domain = C.hostOf(r.website || '');
    return {
      id: String(r.id), full: clean,
      first: (r.firstName || tokens[0] || '').replace(/\.$/, ''),
      last: tokens.length > 1 ? tokens[tokens.length - 1] : '',
      company: r.company || r.liCompany || '', domain,
      linkedin: /linkedin\.com\/(in|pub)\//.test(r.url) ? r.url : '',
    };
  }

  function applyContact(r, res, want) {
    let found = false;
    if (want.email) {
      if (res.email && !r.email) { r.email = res.email; r.emailStatus = res.emailStatus || ''; found = true; }
      markTried(r, 'email');
    }
    if (want.phone) {
      if (res.phone && !r.phone) { r.phone = res.phone; found = true; }
      markTried(r, 'phone');
    }
    if (found) r.contactSource = CONTACT_NAMES[server.contactProvider || 'hunter'];
    return found;
  }

  async function doContact(path, body) {
    const resp = await api(path, body);
    if (resp.ok) {
      run.consecutiveErrors = 0;
      if (server.contactProvider !== 'mock') run.contactCalls = (run.contactCalls || 0) + 1;
    } else {
      run.errors++;
      run.consecutiveErrors++;
      if (resp.fatal || resp.offline) {
        run.stop = true;
        run.fatal = resp.error;
      } else if (run.consecutiveErrors >= 5 && !run.paused) {
        run.paused = true;
        showBanner('error', '5 email/phone lookups failed in a row, so the run is paused. Last error: ' + resp.error
          + ' Fix the problem, then press Resume.');
        renderRunButtons();
      }
    }
    return resp;
  }

  async function pollContactJob(job) {
    const deadline = Date.now() + 20 * 60 * 1000;
    while (!run.stop && Date.now() < deadline) {
      await waitIfPaused();
      const resp = await doContact('/api/contact/poll', { job: job.job });
      if (!resp.ok) { if (run.stop) return false; await sleep(10000); continue; }
      if (!resp.done) { await sleep(5000); continue; }
      const byId = new Map(state.rows.map(r => [String(r.id), r]));
      (resp.results || []).forEach(res => {
        const r = byId.get(res.id) || byId.get(job.ids[res.index]);
        if (r) applyContact(r, res, job.want);
      });
      job.ids.forEach(id => {
        const r = byId.get(id);
        if (r) { if (job.want.email) markTried(r, 'email'); if (job.want.phone) markTried(r, 'phone'); }
      });
      state.contactJobs.splice(state.contactJobs.indexOf(job), 1);
      return true;
    }
    return false;
  }

  // Runs inside a search run (after people and companies) or on its own from the button.
  async function lookUpContacts(list) {
    const want = contactWants();
    const cp = server.contactProvider || 'hunter';
    if (!want.any || (!list.length && !state.contactJobs.length)) return '';
    run.kind = 'contacts';
    run.total = list.length;
    run.done = 0;
    renderProgress();
    const before = new Map(list.map(r => [r, { e: r.email, p: r.phone }]));
    if (cp === 'fullenrich') {
      // Finish batches from an earlier run first, so nobody is paid for twice.
      for (const job of state.contactJobs.slice()) { if (run.stop) break; await pollContactJob(job); }
      for (let i = 0; i < list.length && !run.stop; i += 100) {
        await waitIfPaused();
        const chunk = list.slice(i, i + 100);
        const resp = await doContact('/api/contact/start', { people: chunk.map(personFor), want: { email: want.email, phone: want.phone } });
        if (!resp.ok) break;
        const job = { job: resp.job, ids: chunk.map(r => String(r.id)), want: { email: want.email, phone: want.phone }, started: Date.now() };
        state.contactJobs.push(job);
        await saveNow();
        await pollContactJob(job);
        run.done = Math.min(list.length, i + chunk.length);
        renderProgress();
        scheduleRender();
        scheduleSave();
      }
    } else {
      await runPool(list, async r => {
        await waitIfPaused();
        if (run.stop) return;
        const resp = await doContact('/api/contact', { person: personFor(r), want: { email: want.email, phone: want.phone } });
        if (resp.ok) applyContact(r, resp, want);
        run.done++;
        renderProgress();
        scheduleRender();
        scheduleSave();
      }, Math.min(state.settings.concurrency, 3));
    }
    let emails = 0, phones = 0;
    before.forEach((b, r) => { if (!b.e && r.email) emails++; if (!b.p && r.phone) phones++; });
    let text = 'Contacts: ' + emails + ' emails' + (want.phone ? ' and ' + phones + ' phone numbers' : '') + ' found for ' + plural(list.length, 'lead') + '.';
    if (state.contactJobs.length) text += ' FullEnrich is still working on ' + plural(state.contactJobs.reduce((n, j) => n + j.ids.length, 0), 'lead') + ' – click “Find emails & phones only” later to collect them (no extra credits).';
    return text;
  }

  async function runContactDetails() {
    const want = contactWants();
    if (!want.any) {
      toast('Tick “Email” and/or “Phone number” in section 2 first.');
      return;
    }
    if (run.active || !contactReady(true)) return;
    const list = contactTargets(state.rows);
    if (!list.length && !state.contactJobs.length) {
      toast(state.rows.length ? 'No matched leads need an email or phone from this provider.' : 'Add and search some leads first.');
      return;
    }
    const lookups = list.length * ((want.email ? 1 : 0) + (want.phone ? 1 : 0));
    if (server.contactProvider !== 'mock' && lookups > 20
      && !window.confirm('Look up ' + (want.email ? 'emails' : '') + (want.email && want.phone ? ' and ' : '') + (want.phone ? 'phone numbers' : '')
        + ' for ' + plural(list.length, 'lead') + '? This uses your ' + CONTACT_NAMES[server.contactProvider] + ' credits – check your plan first.')) return;
    startRun('contacts', list.length);
    const summary = await lookUpContacts(list);
    await finishRun(summary || 'Nothing to look up.');
  }

  // ---------------------------------------------------------------- company details (website, LinkedIn page)

  function companySearchesEach() {
    return (state.settings.findWebsite ? 1 : 0) + (state.settings.findCompanyPage ? 1 : 0);
  }

  function rowCompany(r) { return r.company || r.liCompany || ''; }

  // Unique companies of these rows that still need a website or LinkedIn page lookup.
  function companiesToLookUp(rows) {
    const s = state.settings;
    const out = new Map();
    rows.forEach(r => {
      const name = rowCompany(r);
      const key = C.companyKey(name);
      if (!key || out.has(key)) return;
      const info = state.companyInfo[key];
      const needWeb = s.findWebsite && !(info && info.webDone);
      const needPage = s.findCompanyPage && !(info && info.pageDone);
      if (needWeb || needPage) out.set(key, name);
    });
    return Array.from(out, ([key, name]) => ({ key, name }));
  }

  function applyCompanyInfo(r) {
    const info = state.companyInfo[C.companyKey(rowCompany(r))];
    if (!info) return;
    r.website = info.website || '';
    r.companyUrl = info.pageUrl || '';
    r.companyIndustry = info.industry || '';
    r.companySize = info.size ? info.size + ' employees' : '';
    r.companyHq = info.hq || '';
  }

  async function lookUpCompany(co) {
    const s = state.settings;
    const info = state.companyInfo[co.key] || { name: co.name, website: '', websiteHow: '', pageUrl: '', pageName: '',
      industry: '', size: '', hq: '', followers: '', webDone: false, pageDone: false };
    state.companyInfo[co.key] = info;
    const takePage = page => {
      info.pageUrl = page.url;
      info.pageName = page.name;
      info.industry = page.industry || info.industry;
      info.size = page.size || info.size;
      info.hq = page.hq || info.hq;
      info.followers = page.followers || info.followers;
      if (!info.website && page.website) info.website = page.website.startsWith('http') ? page.website : 'https://' + page.website;
    };
    const query = C.companyForQuery(co.name) || co.name;
    if (s.findWebsite && !info.webDone) {
      const resp = await doSearch(query, 1, 'web', { meta: { company: co.name } });
      if (!resp.ok) return false;
      const site = C.pickWebsite(co.name, resp.results, resp.kg);
      if (site) { info.website = site.url; info.websiteHow = site.how; }
      const page = !info.pageUrl && C.pickCompanyPage(co.name, resp.results);
      if (page) { takePage(page); info.pageDone = true; }
      info.webDone = true;
    }
    if (s.findCompanyPage && !info.pageDone) {
      if (run.stop) return false;
      const resp = await doSearch('site:linkedin.com/company/ ' + query, 1, 'company', { meta: { company: co.name } });
      if (!resp.ok) return false;
      const page = C.pickCompanyPage(co.name, resp.results);
      if (page) takePage(page);
      info.pageDone = true;
    }
    return true;
  }

  // Runs inside a search run (after the people) or on its own from the button.
  async function lookUpCompanies(list) {
    if (!list.length) return '';
    run.kind = 'companyinfo';
    run.total = list.length;
    run.done = 0;
    renderProgress();
    await runPool(list, async co => {
      await waitIfPaused();
      if (run.stop) return;
      await lookUpCompany(co);
      run.done++;
      renderProgress();
      scheduleSave();
    }, state.settings.concurrency);
    state.rows.forEach(applyCompanyInfo);
    const done = list.map(co => state.companyInfo[co.key]).filter(Boolean);
    const sites = done.filter(i => i.website).length, pages = done.filter(i => i.pageUrl).length;
    return 'Companies: ' + sites + ' of ' + list.length + ' websites and ' + pages + ' LinkedIn pages found.';
  }

  async function runCompanyDetails() {
    if (!companySearchesEach()) { toast('Tick “Company website” or “Company LinkedIn page” first.'); return; }
    if (!preflight()) return;
    const list = companiesToLookUp(state.rows);
    if (!list.length) {
      state.rows.forEach(applyCompanyInfo);
      renderAll();
      toast(state.rows.length ? 'All companies in the sheet are already looked up.' : 'Add some leads first.');
      return;
    }
    const max = list.length * companySearchesEach();
    if (server.provider !== 'mock' && max > 50
      && !window.confirm('Look up ' + plural(list.length, 'company').replace('companys', 'companies') + '? This can use up to '
        + max + ' search credits. Searches already cached are free.')) return;
    startRun('companyinfo', list.length);
    const summary = await lookUpCompanies(list);
    await finishRun(summary);
  }

  function xrayOptions() { return Object.assign({}, state.settings.xray); }

  function queryCountText(n) { return n + (n === 1 ? ' search' : ' searches'); }

  function previewXray() {
    const plan = C.buildLeadPlan(xrayOptions());
    const pre = $('xQueries');
    if (!plan.length) {
      pre.hidden = true;
      setMsg('xMsg', 'Fill in at least one filter (designation, seniority, company, region, keyword) or write a query.', 'bad');
      return plan;
    }
    const x = state.settings.xray;
    pre.hidden = false;
    pre.textContent = plan.map(p => p.query).join('\n');
    const maxResults = plan.length * x.maxPages * 10;
    let msg = queryCountText(plan.length) + ' · up to ' + plan.length * x.maxPages + ' credits · up to about ' + maxResults + ' results';
    if (maxResults < x.target) msg += ' – fewer than your target of ' + x.target + ', add more designations, companies or regions';
    if (C.normSpace(x.companies) && x.maxPages > 2) msg += ' · Tip: 1–2 pages per search is usually enough when searching by company';
    if (plan.length >= 5000) msg += ' · Limited to the first 5000 searches';
    setMsg('xMsg', msg, maxResults < x.target ? 'bad' : '');
    return plan;
  }

  async function runXray() {
    const plan = previewXray();
    if (!plan.length || !preflight()) return;
    const x = state.settings.xray;
    const filters = xrayOptions();
    const maxCredits = plan.length * x.maxPages;
    if (server.provider !== 'mock' && maxCredits > 50
      && !window.confirm('Run ' + queryCountText(plan.length) + ' to find up to ' + x.target + ' leads? This can use up to '
        + maxCredits + ' search credits. It stops as soon as ' + x.target + ' matching leads are found.')) return;
    const urls = new Set(state.rows.map(r => r.url).filter(Boolean));
    const keys = new Set(state.rows.map(r => C.leadKey(r)));
    let found = 0, review = 0, dropped = 0;
    startRun('xray', x.target);
    await runPool(plan, async item => {
      for (let page = 1; page <= x.maxPages; page++) {
        await waitIfPaused();
        if (run.stop || found >= x.target) return;
        const resp = await doSearch(item.query, page, 'xray', { gl: x.country, meta: item.meta });
        if (!resp.ok) return;
        let fresh = 0;
        for (const r of resp.results) {
          if (found >= x.target) break;
          const chk = C.checkLeadFilters(r, filters);
          if (!chk) continue;
          const p = chk.profile;
          if (!p.name || p.name.length > 80 || urls.has(p.url)) continue;
          const company = p.company || (chk.checks.company && chk.matchedCompany ? chk.matchedCompany : '');
          const lead = { name: p.name, title: p.title || p.headline, company, location: p.location, url: p.url };
          const key = C.leadKey(lead);
          if (keys.has(key)) continue;
          urls.add(p.url);
          keys.add(key);
          fresh++;
          if (x.strict && !chk.strictPass) { dropped++; continue; }
          state.rows.push(newRow(lead, 'Lead search', {
            status: chk.pass ? 'Found' : 'Review', match: chk.label,
            note: chk.pass ? '' : 'Does not match every filter – please check',
            resultTitle: trunc(p.resultTitle, 300), snippet: trunc(p.snippet, 500), query: item.query,
          }));
          if (chk.pass) found++; else review++;
        }
        run.done = found;
        renderProgress();
        scheduleRender();
        scheduleSave();
        // Stop paging this search when Google has nothing more, or a later page brings nobody new.
        if (!resp.hasMore || !resp.results.length || (page > 1 && !fresh)) return;
      }
    }, state.settings.concurrency);
    run.done = found;
    let summary = 'Found ' + plural(found, 'lead') + ' matching your filters';
    if (review) summary += ' + ' + review + ' to review';
    if (dropped) summary += ' (' + dropped + ' left out by strict mode)';
    if (found < x.target && !run.stop) summary += ' – Google had no more results for these searches; add more designations, companies or regions to find more';
    await finishRun(summary + '.');
  }

  // ---------------------------------------------------------------- company search

  function companyOptions() { return Object.assign({}, state.settings.company); }

  function previewCompanies() {
    const plan = C.buildCompanyPlan(companyOptions());
    const pre = $('cQueries');
    if (!plan.length) {
      pre.hidden = true;
      setMsg('cMsg', 'Enter at least one industry/keyword or location, or write a query.', 'bad');
      return plan;
    }
    const c = state.settings.company;
    pre.hidden = false;
    pre.textContent = plan.map(p => p.query).join('\n');
    const maxResults = plan.length * c.maxPages * 10;
    setMsg('cMsg', queryCountText(plan.length) + ' · up to ' + plan.length * c.maxPages + ' credits · up to about ' + maxResults
      + ' companies' + (maxResults < c.target ? ' – fewer than your target of ' + c.target + ', add more keywords or locations' : ''),
      maxResults < c.target ? 'bad' : '');
    return plan;
  }

  function sizeAllowed(company, opts) {
    if (!opts.sizes.length) return true;
    if (!company.sizeBucket) return !!opts.unknownSize;
    return opts.sizes.includes(company.sizeBucket);
  }

  async function runCompanySearch() {
    const plan = previewCompanies();
    if (!plan.length || !preflight()) return;
    const c = companyOptions();
    const maxCredits = plan.length * c.maxPages;
    if (server.provider !== 'mock' && maxCredits > 50
      && !window.confirm('Run ' + queryCountText(plan.length) + ' to find up to ' + c.target + ' companies? This can use up to '
        + maxCredits + ' search credits. It stops as soon as ' + c.target + ' companies are found.')) return;
    const urls = new Set(state.companies.map(x => x.url));
    const names = new Set(state.companies.map(x => C.fold(x.name)));
    let found = 0, skippedSize = 0;
    startRun('company', c.target);
    await runPool(plan, async item => {
      for (let page = 1; page <= c.maxPages; page++) {
        await waitIfPaused();
        if (run.stop || found >= c.target) return;
        const resp = await doSearch(item.query, page, 'company', { gl: c.country, meta: item.meta });
        if (!resp.ok) return;
        let fresh = 0;
        for (const r of resp.results) {
          if (found >= c.target) break;
          const co = C.parseCompanyResult(r);
          if (!co || urls.has(co.url) || names.has(C.fold(co.name))) continue;
          urls.add(co.url);
          names.add(C.fold(co.name));
          fresh++;
          if (!sizeAllowed(co, c)) { skippedSize++; continue; }
          state.companies.push(sanitizeCompany(Object.assign({}, co, {
            snippet: trunc(co.snippet, 400), query: item.query, selected: true,
          }), state.nextId++));
          found++;
        }
        run.done = found;
        renderProgress();
        renderCompanies();
        scheduleSave();
        if (!resp.hasMore || !resp.results.length || (page > 1 && !fresh)) return;
      }
    }, state.settings.concurrency);
    run.done = found;
    let summary = 'Found ' + plural(found, 'new company').replace('companys', 'companies');
    if (skippedSize) summary += ' (' + skippedSize + ' left out by the size filter)';
    if (found < c.target && !run.stop) summary += ' – Google had no more results; add more keywords or locations to find more';
    await finishRun(summary + '. Tick the ones you want and click “Find people at selected companies”.');
    renderCompanies();
  }

  function renderCompanies() {
    const list = state.companies;
    const selected = list.filter(c => c.selected).length;
    $('companyCount').textContent = list.length ? '(' + list.length + ' found, ' + selected + ' selected)' : '';
    $('companyEmpty').hidden = list.length > 0;
    $('cUseBtn').disabled = !selected || run.active;
    $('cRun').disabled = run.active;
    const size = 100;
    const pages = Math.max(1, Math.ceil(list.length / size));
    view.cpage = Math.min(Math.max(1, view.cpage), pages);
    const start = (view.cpage - 1) * size;
    const frag = document.createDocumentFragment();
    list.slice(start, start + size).forEach(c => {
      const href = safeHref(c.url);
      frag.appendChild(el('tr', { 'data-cid': c.id }, [
        el('td', null, [el('input', { type: 'checkbox', className: 'csel', checked: c.selected, 'aria-label': 'Select ' + c.name })]),
        el('td', null, [el('b', { text: c.name }), c.website ? el('span', { className: 'sub', text: c.website }) : null]),
        el('td', { text: c.industry }),
        el('td', { text: c.size || '–' }),
        el('td', { text: c.hq }),
        el('td', { className: 'num', text: c.followers }),
        el('td', null, [href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: href.replace('https://www.', '') }) : null]),
        el('td', null, [el('button', { className: 'linkbtn', 'data-cact': 'delete', title: 'Remove', text: '✕' })]),
      ]));
    });
    $('companyTbody').replaceChildren(frag);
    const pager = $('companyPager');
    pager.replaceChildren();
    if (pages > 1) {
      const prev = el('button', { className: 'btn small', text: '‹ Prev', disabled: view.cpage <= 1 });
      const next = el('button', { className: 'btn small', text: 'Next ›', disabled: view.cpage >= pages });
      prev.addEventListener('click', () => { view.cpage--; renderCompanies(); });
      next.addEventListener('click', () => { view.cpage++; renderCompanies(); });
      pager.append(prev, el('span', { text: 'Page ' + view.cpage + ' of ' + pages }), next);
    }
  }

  function onCompanyClick(ev) {
    const tr = ev.target.closest('tr[data-cid]');
    if (!tr) return;
    const c = state.companies.find(x => x.id === Number(tr.getAttribute('data-cid')));
    if (!c) return;
    if (ev.target.classList.contains('csel')) {
      c.selected = ev.target.checked;
    } else if (ev.target.closest('button[data-cact="delete"]')) {
      state.companies.splice(state.companies.indexOf(c), 1);
    } else {
      return;
    }
    renderCompanies();
    scheduleSave();
  }

  function useSelectedCompanies() {
    const names = state.companies.filter(c => c.selected).map(c => c.name);
    if (!names.length) { toast('Tick at least one company first.'); return; }
    sendCompaniesToLeadSearch(names);
  }

  function sendCompaniesToLeadSearch(names) {
    const x = state.settings.xray;
    const merged = [];
    const seen = new Set();
    x.companies.split('\n').concat(names).map(C.normSpace).filter(Boolean).forEach(n => {
      if (!seen.has(C.fold(n))) { seen.add(C.fold(n)); merged.push(n); }
    });
    x.companies = merged.join('\n');
    x.currentOnly = true;
    $('xCompanies').value = x.companies;
    $('xCurrentOnly').checked = true;
    showTab('xray');
    scheduleSave();
    $('xTitles').focus();
    setMsg('xMsg', names.length + (names.length === 1 ? ' company' : ' companies')
      + ' added. Now add designations or seniority (and regions if you like), then click Preview searches.', 'ok');
  }

  function exportCompanies(kind) {
    if (!state.companies.length) { toast('No companies to export.'); return; }
    const rows = state.companies.map((c, i) => Object.assign({}, c, { no: i + 1, size: c.size ? c.size + ' employees' : '' }));
    if (kind === 'xlsx') {
      download(C.toXLSX(COMPANY_COLUMNS, rows, 'Companies'), 'linkedin-companies_' + stamp() + '.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } else {
      download(C.toCSV(COMPANY_COLUMNS, rows), 'linkedin-companies_' + stamp() + '.csv', 'text/csv;charset=utf-8');
    }
    toast('Downloading ' + rows.length + ' companies. Check your Downloads folder.');
  }

  function countStatuses(rows) {
    const c = { matched: 0, review: 0, notfound: 0, error: 0, pending: 0, searching: 0 };
    rows.forEach(r => { c[GROUP[r.status] || 'pending']++; });
    return c;
  }

  // ---------------------------------------------------------------- rendering

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderAll(); });
  }

  function renderRunButtons() {
    $('runBtn').disabled = run.active;
    $('companyInfoBtn').disabled = run.active;
    $('contactBtn').disabled = run.active;
    $('xRun').disabled = run.active;
    $('cRun').disabled = run.active;
    $('cUseBtn').disabled = run.active || !state.companies.some(c => c.selected);
    $('pauseBtn').disabled = !run.active;
    $('stopBtn').disabled = !run.active;
    $('pauseBtn').textContent = run.paused ? 'Resume' : 'Pause';
    $('clearBtn').disabled = run.active;
  }

  function renderProgress() {
    const pct = run.total ? Math.min(100, Math.round((100 * run.done) / run.total)) : 0;
    $('progressBar').style.width = (run.active || run.done ? pct : 0) + '%';
    if (!run.active) return;
    const secs = (Date.now() - run.started) / 1000;
    let eta = '';
    if (run.kind === 'find' && run.done > 2 && run.done < run.total) {
      const left = Math.round(((run.total - run.done) * secs) / run.done);
      eta = ' · about ' + (left > 90 ? Math.round(left / 60) + ' min' : left + ' s') + ' left';
    }
    const what = run.kind === 'xray' ? 'matching leads found' : run.kind === 'company' ? 'companies found'
      : run.kind === 'companyinfo' ? 'companies looked up (website, LinkedIn page)'
      : run.kind === 'contacts' ? 'leads looked up for email / phone' : 'leads searched';
    setMsg('progressText', (run.paused ? 'Paused · ' : '') + run.done + ' / ' + run.total + ' ' + what + ' · '
      + run.credits + ' credits used' + (run.cached ? ' · ' + run.cached + ' cached' : '')
      + (run.errors ? ' · ' + plural(run.errors, 'error') : '') + eta);
  }

  function filteredRows() {
    const q = C.fold(view.search);
    return state.rows.filter(r => {
      const g = GROUP[r.status] === 'searching' ? 'pending' : GROUP[r.status];
      if (view.filter !== 'all' && g !== view.filter) return false;
      if (q && !C.fold([r.name, r.title, r.company, r.location, r.url, r.note].join(' ')).includes(q)) return false;
      return true;
    });
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') e.textContent = v;
        else if (k === 'className') e.className = v;
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(c => { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  // A score only exists after a profile search (not for Lead search finds or manual URLs).
  function hasScore(r) {
    return (r.status === 'Matched' || r.status === 'Review' || r.status === 'Not found') && (r.confidence > 0 || r.candidates.length > 0);
  }

  function statusBadge(r) {
    const g = GROUP[r.status] || 'pending';
    return el('span', { className: 'badge ' + g, text: STATUS_LABEL[r.status] || r.status });
  }

  function renderRow(r, index) {
    const tr = el('tr', { 'data-id': r.id });
    tr.appendChild(el('td', { className: 'num', text: String(index + 1) }));
    tr.appendChild(el('td', null, [
      el('span', { text: r.name }),
      r.degree ? el('span', { className: 'deg', text: r.degree }) : null,
      r.source !== 'Sales Navigator' ? el('span', { className: 'sub', text: r.source }) : null,
      r.email ? el('span', { className: 'sub contact', text: '✉ ' + r.email + (r.emailStatus ? ' (' + r.emailStatus + ')' : '') }) : null,
      r.phone ? el('span', { className: 'sub contact', text: '☎ ' + r.phone }) : null,
    ]));
    tr.appendChild(el('td', { text: r.title }));
    const site = safeHref(r.website), page = safeHref(r.companyUrl);
    tr.appendChild(el('td', null, [
      el('span', { text: r.company }),
      r.liCompany && C.companyKey(r.liCompany) !== C.companyKey(r.company) ? el('span', { className: 'sub', text: 'LinkedIn: ' + r.liCompany }) : null,
      site || page ? el('span', { className: 'sub links' }, [
        site ? el('a', { href: site, target: '_blank', rel: 'noopener noreferrer', text: site.replace(/^https?:\/\/(www\.)?/, '') }) : null,
        site && page ? ' · ' : null,
        page ? el('a', { href: page, target: '_blank', rel: 'noopener noreferrer', text: 'LinkedIn page' }) : null,
      ]) : null,
    ]));
    tr.appendChild(el('td', { text: r.location }));
    const href = safeHref(r.url);
    tr.appendChild(el('td', null, [el('div', { className: 'urlcell' }, [
      el('input', { type: 'text', className: 'url', value: r.url, placeholder: 'paste URL if you find it yourself', 'aria-label': 'LinkedIn URL for ' + r.name }),
      href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', title: 'Open profile', text: '↗' }) : null,
    ])]));
    tr.appendChild(el('td', null, [statusBadge(r), r.error ? el('span', { className: 'err', text: r.error }) : null,
      r.match ? el('span', { className: 'match', text: r.match }) : null]));
    tr.appendChild(el('td', { className: 'num', text: hasScore(r) ? String(r.confidence) : '' }));
    const q = r.query || C.buildFindQueries(r, state.settings.templates)[0] || '';
    tr.appendChild(el('td', { className: 'actions' }, [
      q ? el('a', { href: C.googleUrl(q), target: '_blank', rel: 'noopener noreferrer', title: q, text: 'Google' }) : null,
      r.status === 'Review' ? el('button', { className: 'linkbtn', 'data-act': 'confirm', title: 'Mark this profile as correct', text: '✓' }) : null,
      el('button', { className: 'linkbtn', 'data-act': 'retry', title: 'Search this lead again', text: '↻', disabled: run.active }),
      el('button', { className: 'linkbtn', 'data-act': 'details', title: 'Show the Google results that were checked', text: view.open.has(r.id) ? '▴' : '▾' }),
      el('button', { className: 'linkbtn', 'data-act': 'delete', title: 'Remove this row', text: '✕', disabled: run.active }),
    ]));
    return tr;
  }

  function renderDetails(r) {
    const td = el('td', { colspan: '9' });
    if (!r.candidates.length) {
      td.appendChild(el('div', { className: 'muted', text: r.query ? 'No LinkedIn profiles were in the results for: ' + r.query : 'Not searched yet.' }));
    } else {
      const box = el('div', { className: 'cands' });
      r.candidates.forEach((c, i) => {
        box.appendChild(el('div', { className: 'cand' }, [
          el('span', { className: 'score', text: c.confidence + '%' }),
          el('div', { className: 'body' }, [
            el('div', null, [el('b', { text: c.resultTitle || c.name }), ' ', el('span', { className: 'muted', text: '(' + c.verdict + ': ' + c.why + ')' })]),
            el('a', { href: safeHref(c.url), target: '_blank', rel: 'noopener noreferrer', text: c.url }),
            c.snippet ? el('div', { className: 'snip', text: c.snippet }) : null,
          ]),
          el('button', { className: 'btn small', 'data-act': 'use', 'data-i': String(i), text: c.url === r.url && r.status === 'Manual' ? 'Chosen' : 'Use this' }),
        ]));
      });
      td.appendChild(box);
    }
    return el('tr', { className: 'details', 'data-id': r.id }, [td]);
  }

  function renderTable() {
    const tbody = $('tbody');
    if (tbody.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // user is typing
    const rows = filteredRows();
    const pages = Math.max(1, Math.ceil(rows.length / view.pageSize));
    view.page = Math.min(Math.max(1, view.page), pages);
    const start = (view.page - 1) * view.pageSize;
    const index = new Map(state.rows.map((r, i) => [r, i]));
    const frag = document.createDocumentFragment();
    rows.slice(start, start + view.pageSize).forEach(r => {
      frag.appendChild(renderRow(r, index.get(r)));
      if (view.open.has(r.id)) frag.appendChild(renderDetails(r));
    });
    tbody.replaceChildren(frag);
    $('emptyMsg').hidden = rows.length > 0;
    $('emptyMsg').textContent = state.rows.length ? 'No rows match this filter.' : 'No leads yet. Paste a Sales Navigator page above, or use Lead search / Company search.';

    const pager = $('pager');
    pager.replaceChildren();
    if (rows.length > 25) {
      const size = el('select', { 'aria-label': 'Rows per page' });
      [25, 50, 100, 250, 500].forEach(n => size.appendChild(el('option', { value: String(n), text: n + ' per page', selected: n === view.pageSize })));
      size.addEventListener('change', () => { view.pageSize = Number(size.value); view.page = 1; renderTable(); });
      const prev = el('button', { className: 'btn small', text: '‹ Prev', disabled: view.page <= 1 });
      const next = el('button', { className: 'btn small', text: 'Next ›', disabled: view.page >= pages });
      prev.addEventListener('click', () => { view.page--; renderTable(); });
      next.addEventListener('click', () => { view.page++; renderTable(); });
      pager.append(size, prev, el('span', { text: 'Page ' + view.page + ' of ' + pages + ' (' + rows.length + ' rows)' }), next);
    }
  }

  function renderCounts() {
    const c = countStatuses(state.rows);
    $('rowCount').textContent = state.rows.length ? '(' + plural(state.rows.length, 'lead') + ')' : '';
    const labels = { all: 'All ' + state.rows.length, matched: 'Matched / found ' + c.matched, review: 'Review ' + c.review,
      notfound: 'Not found ' + c.notfound, error: 'Errors ' + c.error, pending: 'Not searched ' + (c.pending + c.searching) };
    document.querySelectorAll('#filters .pill').forEach(b => {
      b.textContent = labels[b.dataset.f];
      b.classList.toggle('active', b.dataset.f === view.filter);
    });
  }

  function renderAll() {
    renderCounts();
    renderTable();
    renderRunButtons();
    renderProgress();
    updateEstimate();
  }

  // ---------------------------------------------------------------- table actions

  function rowById(id) { return state.rows.find(r => r.id === id); }

  function onTableClick(ev) {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr[data-id]');
    const row = tr && rowById(Number(tr.getAttribute('data-id')));
    if (!row) return;
    const act = btn.getAttribute('data-act');
    if (act === 'details') {
      if (view.open.has(row.id)) view.open.delete(row.id); else view.open.add(row.id);
    } else if (act === 'delete') {
      if (run.active) return;
      state.rows.splice(state.rows.indexOf(row), 1);
      view.open.delete(row.id);
      toast('Removed ' + row.name + '.');
    } else if (act === 'retry') {
      if (run.active) return;
      runFind([row]);
      return;
    } else if (act === 'confirm') {
      row.status = 'Manual';
      row.note = 'Confirmed by you · ' + row.note.replace(/^Please check: /, '');
      fillBlanksFromLinkedIn(row);
    } else if (act === 'use') {
      const c = row.candidates[Number(btn.getAttribute('data-i'))];
      if (!c) return;
      row.url = c.url;
      row.status = 'Manual';
      row.confidence = c.confidence;
      row.resultTitle = c.resultTitle;
      row.snippet = c.snippet;
      row.query = c.query || row.query;
      row.note = 'Chosen by you';
      row.liTitle = c.title;
      row.liCompany = c.company;
      row.liLocation = c.location;
      fillBlanksFromLinkedIn(row);
    }
    renderAll();
    scheduleSave();
  }

  function onTableChange(ev) {
    const input = ev.target;
    if (!input.classList.contains('url')) return;
    const tr = input.closest('tr[data-id]');
    const row = tr && rowById(Number(tr.getAttribute('data-id')));
    if (!row) return;
    const raw = input.value.trim();
    if (!raw) {
      row.url = '';
      row.status = 'Pending';
      row.note = '';
    } else {
      const norm = C.normalizeLinkedInUrl(raw.startsWith('http') ? raw : 'https://' + raw);
      if (!norm) { toast('That is not a LinkedIn profile URL (it should contain linkedin.com/in/).'); input.value = row.url; return; }
      row.url = norm;
      row.status = 'Manual';
      row.note = 'Entered by you';
      row.error = '';
    }
    input.blur();
    renderAll();
    scheduleSave();
  }

  // ---------------------------------------------------------------- export

  function exportRows() {
    const scope = state.settings.exportScope;
    let rows = scope === 'filtered' ? filteredRows() : state.rows.slice();
    if (scope === 'matched') rows = rows.filter(r => GROUP[r.status] === 'matched');
    if (scope === 'matched_review') rows = rows.filter(r => GROUP[r.status] === 'matched' || GROUP[r.status] === 'review');
    if (scope === 'with_url') rows = rows.filter(r => r.url);
    return rows.map((r, i) => Object.assign({}, r, {
      no: i + 1,
      statusText: STATUS_LABEL[r.status] || r.status,
      confidence: hasScore(r) ? r.confidence : '',
      note: r.error ? (r.note ? r.note + ' · ' : '') + 'Error: ' + r.error : r.note,
    }));
  }

  function exportColumns() { return COLUMNS.filter(c => state.settings.exportColumns.includes(c.key)); }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(data, filename, mime) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Revoking too early cancels the download in some browsers, so wait.
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
  }

  function exportFile(kind) {
    const rows = exportRows();
    const cols = exportColumns();
    if (!rows.length) { toast('No rows to export for “' + $('exportScope').selectedOptions[0].text + '”.'); return; }
    try {
      if (kind === 'xlsx') {
        download(C.toXLSX(cols, rows, 'Leads'), 'linkedin-leads_' + stamp() + '.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      } else {
        download(C.toCSV(cols, rows), 'linkedin-leads_' + stamp() + '.csv', 'text/csv;charset=utf-8');
      }
      toast('Downloading ' + plural(rows.length, 'row') + '. Check your Downloads folder.');
    } catch (e) {
      showBanner('error', 'Could not create the file: ' + (e && e.message ? e.message : e)
        + '. Use “Copy table for Google Sheets” instead and paste into a spreadsheet.');
    }
  }

  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      if (!ok) { toast('Your browser blocked copying. Use the Download buttons instead.'); return; }
    }
    toast('Copied ' + what + '.');
  }

  function renderColumnsPanel() {
    const panel = $('columnsPanel');
    panel.replaceChildren();
    COLUMNS.forEach(c => {
      const cb = el('input', { type: 'checkbox', checked: state.settings.exportColumns.includes(c.key) });
      cb.addEventListener('change', () => {
        const set = new Set(state.settings.exportColumns);
        if (cb.checked) set.add(c.key); else set.delete(c.key);
        if (!set.size) { cb.checked = true; toast('Keep at least one column.'); return; }
        state.settings.exportColumns = COLUMNS.map(x => x.key).filter(k => set.has(k));
        scheduleSave();
      });
      panel.appendChild(el('label', null, [cb, c.label]));
    });
  }

  // ---------------------------------------------------------------- wiring

  function bindEvents() {
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    $('cPreview').addEventListener('click', previewCompanies);
    $('cRun').addEventListener('click', runCompanySearch);
    $('companyTbody').addEventListener('click', onCompanyClick);
    $('cSelectAll').addEventListener('click', () => { state.companies.forEach(c => { c.selected = true; }); renderCompanies(); scheduleSave(); });
    $('cSelectNone').addEventListener('click', () => { state.companies.forEach(c => { c.selected = false; }); renderCompanies(); scheduleSave(); });
    $('cUseBtn').addEventListener('click', useSelectedCompanies);
    $('noNameBtn').addEventListener('click', () => {
      if (!pendingCompanies.length) return;
      sendCompaniesToLeadSearch(pendingCompanies);
      if (!state.settings.xray.seniority.length && !C.normSpace(state.settings.xray.titles)) {
        state.settings.xray.seniority = ['owner', 'cxo'];
        $('xSeniority').querySelectorAll('input[data-k]').forEach(cb => { cb.checked = state.settings.xray.seniority.includes(cb.getAttribute('data-k')); });
      }
      $('noNameBtn').hidden = true;
      pendingCompanies = [];
    });
    $('cXlsxBtn').addEventListener('click', () => exportCompanies('xlsx'));
    $('cCsvBtn').addEventListener('click', () => exportCompanies('csv'));
    $('cClearBtn').addEventListener('click', () => {
      if (run.active || !state.companies.length) return;
      if (!window.confirm('Remove all ' + state.companies.length + ' companies from the list?')) return;
      state.companies = [];
      view.cpage = 1;
      renderCompanies();
      saveNow();
    });
    $('parseBtn').addEventListener('click', parsePaste);
    $('csvFile').addEventListener('change', importFile);
    $('demoBtn').addEventListener('click', () => {
      $('pasteBox').value = demoText();
      setMsg('parseMsg', 'Demo text loaded (made-up people). Click “Clean & add leads”. Use Mock test mode in Settings to try a search for free.');
    });
    $('xPreview').addEventListener('click', previewXray);
    $('xRun').addEventListener('click', runXray);
    $('runBtn').addEventListener('click', () => runFind());
    $('companyInfoBtn').addEventListener('click', runCompanyDetails);
    $('contactBtn').addEventListener('click', runContactDetails);
    $('contactProvider').addEventListener('change', changeContactProvider);
    $('saveContactKeyBtn').addEventListener('click', saveContactKey);
    $('testContactBtn').addEventListener('click', testContactKey);
    $('contactKey').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); saveContactKey(); } });
    $('pauseBtn').addEventListener('click', () => {
      run.paused = !run.paused;
      if (!run.paused) { run.consecutiveErrors = 0; hideBanner(); }
      renderRunButtons();
      renderProgress();
    });
    $('stopBtn').addEventListener('click', () => { run.stop = true; run.paused = false; setMsg('progressText', 'Stopping after the searches in progress…'); });
    $('openSettings').addEventListener('click', openSettings);
    $('provider').addEventListener('change', changeProvider);
    $('saveKeyBtn').addEventListener('click', saveKey);
    // Pressing Enter inside the settings form must not close it (and lose a pasted key).
    $('settings').querySelector('form').addEventListener('submit', ev => {
      if (!(ev.submitter && ev.submitter.value === 'close')) ev.preventDefault();
    });
    $('apiKey').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); saveKey(); } });
    $('testKeyBtn').addEventListener('click', testKey);
    $('clearCacheBtn').addEventListener('click', async () => {
      const r = await api('/api/cache/clear', {});
      toast(r.ok ? 'Search cache cleared.' : 'Could not clear the cache: ' + r.error);
    });
    $('bannerClose').addEventListener('click', hideBanner);
    $('searchBox').addEventListener('input', () => { view.search = $('searchBox').value; view.page = 1; renderTable(); });
    $('filters').addEventListener('click', ev => {
      const b = ev.target.closest('.pill');
      if (!b) return;
      view.filter = b.dataset.f;
      view.page = 1;
      renderAll();
    });
    $('tbody').addEventListener('click', onTableClick);
    $('tbody').addEventListener('change', onTableChange);
    $('tbody').addEventListener('focusout', () => setTimeout(() => { if (!$('tbody').contains(document.activeElement)) scheduleRender(); }, 0));
    $('xlsxBtn').addEventListener('click', () => exportFile('xlsx'));
    $('csvBtn').addEventListener('click', () => exportFile('csv'));
    $('copyTableBtn').addEventListener('click', () => {
      const rows = exportRows();
      if (!rows.length) { toast('No rows to copy.'); return; }
      copyText(C.toTSV(exportColumns(), rows), plural(rows.length, 'row') + ' – paste into Google Sheets or Excel');
    });
    $('copyUrlsBtn').addEventListener('click', () => {
      const urls = exportRows().map(r => r.url).filter(Boolean);
      if (!urls.length) { toast('No LinkedIn URLs yet.'); return; }
      copyText(urls.join('\n'), plural(urls.length, 'URL'));
    });
    $('copyQueriesBtn').addEventListener('click', () => {
      const qs = exportRows().map(r => r.query || C.buildFindQueries(r, state.settings.templates)[0]).filter(Boolean);
      if (!qs.length) { toast('No queries to copy.'); return; }
      copyText(qs.join('\n'), plural(qs.length, 'Google query').replace('querys', 'queries'));
    });
    $('columnsBtn').addEventListener('click', () => {
      const p = $('columnsPanel');
      p.hidden = !p.hidden;
      if (!p.hidden) renderColumnsPanel();
    });
    $('clearBtn').addEventListener('click', () => {
      if (run.active || !state.rows.length) return;
      if (!window.confirm('Delete all ' + state.rows.length + ' rows from the sheet? Download them first if you need them.')) return;
      state.rows = [];
      view.open.clear();
      view.page = 1;
      renderAll();
      saveNow();
    });
    window.addEventListener('beforeunload', ev => {
      if (run.active) { ev.preventDefault(); ev.returnValue = ''; }
    });
  }

  function showTab(name) {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    ['paste', 'xray', 'company'].forEach(n => { $('tab-' + n).hidden = n !== name; });
  }

  async function init() {
    buildStaticOptions();
    bindEvents();
    await refreshServer();
    await loadState();
    fillForm();
    bindForm();
    renderAll();
    renderCompanies();
    if (server.ok && !keyReady()) {
      showBanner('warn', 'Welcome! Open Settings to paste your SerpApi or Serper API key, or pick “Mock test mode” to try everything for free.');
    }
    if (!server.ok && location.protocol !== 'file:') {
      showBanner('error', 'Cannot reach the local server. Start START_HERE.py (or start_mac_linux.sh), keep that window open, and reload this page.');
    }
  }

  // Exposed for automated tests only.
  window.__llf = { state, run, view };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
