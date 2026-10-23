/*
 * LinkedIn Lead Finder - core logic.
 * Parser for Sales Navigator copy/paste, Google query builder, result matcher and
 * CSV / Excel writers. No DOM access, so the same file runs in the browser and in Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LeadCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- text helpers

  function str(v) { return v == null ? '' : String(v); }

  function normSpace(s) {
    return str(s).replace(/[  -​  　﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Lower case, no accents, straight apostrophes. Used for every comparison.
  function fold(s) {
    return normSpace(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[‘’‛`´]/g, "'");
  }

  // Word tokens of a string (letters and digits only, any script).
  function words(s) {
    return fold(s).replace(/'/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  }

  function wordString(s) { return ' ' + words(s).join(' ') + ' '; }

  function uniq(list) {
    const seen = new Set();
    return list.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
  }

  function smartCase(token) {
    if (token.length > 1 && (token === token.toUpperCase() || token === token.toLowerCase()) && /\p{L}/u.test(token)) {
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    }
    return token;
  }

  function editDistanceAtMost1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (la > lb) i++;
      else if (lb > la) j++;
      else { i++; j++; }
    }
    return edits + (la - i) + (lb - j) <= 1;
  }

  // ---------------------------------------------------------------- reference lists

  function placeSet(list) { return new Set(list.split('|').map(fold)); }

  const PLACES = placeSet([
    // countries
    'afghanistan|albania|algeria|andorra|angola|argentina|armenia|australia|austria|azerbaijan|bahamas|bahrain|bangladesh|barbados|belarus|belgium|belize|benin|bhutan|bolivia|bosnia and herzegovina|botswana|brazil|brunei|bulgaria|burkina faso|burundi|cambodia|cameroon|canada|cape verde|chad|chile|china|colombia|congo|costa rica|croatia|cuba|cyprus|czechia|czech republic|denmark|djibouti|dominican republic|ecuador|egypt|el salvador|estonia|eswatini|ethiopia|fiji|finland|france|gabon|gambia|georgia|germany|ghana|greece|guatemala|guinea|guyana|haiti|honduras|hong kong|hong kong sar|hungary|iceland|india|indonesia|iran|iraq|ireland|israel|italy|ivory coast|jamaica|japan|jordan|kazakhstan|kenya|kosovo|kuwait|kyrgyzstan|laos|latvia|lebanon|lesotho|liberia|libya|liechtenstein|lithuania|luxembourg|macau|madagascar|malawi|malaysia|maldives|mali|malta|mauritania|mauritius|mexico|moldova|monaco|mongolia|montenegro|morocco|mozambique|myanmar|namibia|nepal|netherlands|the netherlands|new zealand|nicaragua|niger|nigeria|north macedonia|norway|oman|pakistan|palestine|panama|papua new guinea|paraguay|peru|philippines|poland|portugal|puerto rico|qatar|romania|russia|rwanda|saudi arabia|senegal|serbia|seychelles|sierra leone|singapore|slovakia|slovenia|somalia|south africa|south korea|korea|spain|sri lanka|sudan|suriname|sweden|switzerland|syria|taiwan|tajikistan|tanzania|thailand|togo|trinidad and tobago|tunisia|turkey|türkiye|uganda|ukraine|united arab emirates|uae|united kingdom|uk|united states|united states of america|usa|uruguay|uzbekistan|venezuela|vietnam|yemen|zambia|zimbabwe',
    // US states
    'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|washington dc|washington d.c.',
    // Canada, Australia, UK
    'alberta|british columbia|manitoba|new brunswick|newfoundland and labrador|nova scotia|ontario|prince edward island|quebec|saskatchewan|new south wales|victoria|queensland|western australia|south australia|tasmania|england|scotland|wales|northern ireland',
    // India states and union territories
    'andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|new delhi|puducherry|pondicherry|chandigarh|jammu and kashmir|ladakh',
    // major cities that often appear on their own
    'chennai|mumbai|bengaluru|bangalore|hyderabad|pune|kolkata|ahmedabad|gurgaon|gurugram|noida|coimbatore|kochi|jaipur|london|manchester|birmingham|dublin|paris|berlin|munich|amsterdam|madrid|barcelona|milan|rome|zurich|stockholm|copenhagen|oslo|helsinki|brussels|vienna|warsaw|prague|lisbon|dubai|abu dhabi|riyadh|doha|tokyo|seoul|shanghai|beijing|shenzhen|sydney|melbourne|brisbane|perth|auckland|toronto|vancouver|montreal|calgary|new york city|los angeles|san francisco|chicago|houston|dallas|austin|seattle|boston|atlanta|miami|denver|phoenix|san diego|san jose|philadelphia|nairobi|lagos|cairo|johannesburg|cape town|sao paulo|são paulo|mexico city|buenos aires|bogota|lima|santiago|jakarta|kuala lumpur|manila|bangkok|ho chi minh city|hanoi|karachi|lahore|dhaka|colombo|kathmandu',
  ].join('|'));

  const ORG_HINT = /\b(ltd|limited|llp|llc|inc|pvt|private|corp|corporation|company|college|university|universit\w*|institute|school|academy|department|dept|technologies|technology|solutions|services|systems|group|hospital|bank|labs?|centre|center|foundation|council|society|chapter|association|studio|agency|partners|consulting|ventures|capital|media|tech|holdings|industries|enterprises|logistics|robotics|software|healthcare|pharma\w*)\b/;

  const TITLE_HINT = /\b(founder|co-?founder|ceo|cto|cfo|coo|cmo|cio|cxo|chief|head|manager|director|officer|president|vp|svp|evp|avp|engineer|developer|lead|partner|owner|consultant|professor|lecturer|teacher|student|intern|analyst|specialist|executive|member|secretary|mentor|coordinator|advisor|adviser|architect|designer|recruiter|sales|marketing|operations|dean|principal|associate|assistant|administrator|accountant|scientist|researcher|board|chairman|chairperson|trustee|entrepreneur|freelancer|strategist|supervisor|technician|doctor|physician|nurse|surgeon|attorney|lawyer|editor|writer|investor|banker|broker|agent|representative|trainer|coach|tutor|pilot|controller|treasurer|auditor|planner|buyer|producer|programmer)\b/;

  function isLocation(line) {
    const s = normSpace(line);
    if (!s || s.length > 90) return false;
    const f = fold(s);
    if (/\d{3,}/.test(f) || /[@|•·:]/.test(f) || /https?:/.test(f)) return false;
    if (ORG_HINT.test(f) || TITLE_HINT.test(f)) return false;
    if (/\b(area|region|metropolitan|metroplex|metro)\b/.test(f) && f.split(' ').length <= 7) return true;
    if (/^greater\s+\S/.test(f)) return true;
    const segs = f.split(',').map(x => x.trim()).filter(Boolean);
    if (!segs.length) return false;
    if (PLACES.has(segs[segs.length - 1])) return true;
    return segs.length >= 2 && segs.every(seg => /^[\p{L} .'-]+$/u.test(seg) && seg.split(' ').length <= 4);
  }

  // ---------------------------------------------------------------- names

  const HONORIFIC = /^(dr|prof|professor|mr|mrs|ms|miss|mx|er|engr|adv|ca|cs|capt|col|lt|maj|sir|dame|hon|rev)\.?$/i;
  const CREDENTIAL = /^(phd|ph\.d|mba|cpa|cfa|pmp|md|mbbs|msc|bsc|btech|mtech|llb|llm|cissp|cisa|cism|csm|cspo|frm|acca|aca|fca|cma|dba|edd|jd|rn|pe|sphr|phr|ceng|itil)\.?$/i;

  function isInitial(token) { return /^\p{L}\.?$/u.test(token); }

  // "Prof  Dr. Hariharan Ramakrishnan, PhD (He/Him) 🚀" -> "Hariharan Ramakrishnan"
  function cleanPersonName(raw) {
    let s = normSpace(raw).replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ');
    s = s.replace(/[^\p{L}\p{M}\p{N}\s.'’,-]/gu, ' ');
    const comma = s.indexOf(',');
    if (comma > 0) s = s.slice(0, comma);
    const parts = normSpace(s).split(' ').filter(p => p && !/^[.'’-]+$/.test(p));
    while (parts.length > 1 && HONORIFIC.test(parts[0])) parts.shift();
    while (parts.length > 1 && /^[A-Z.]+$/.test(parts[parts.length - 1]) && CREDENTIAL.test(parts[parts.length - 1])) parts.pop();
    return parts.join(' ');
  }

  // Name used inside the quoted Google phrase. Leading/trailing initials are dropped when two
  // full words remain ("R. Anitha Elango" -> "Anitha Elango"); middle initials are kept so the
  // phrase still matches the profile title word for word.
  function searchName(raw) {
    const parts = cleanPersonName(raw).split(' ').filter(Boolean);
    const full = parts.filter(p => !isInitial(p)).length;
    if (full >= 2) {
      while (parts.length && isInitial(parts[0])) parts.shift();
      while (parts.length && isInitial(parts[parts.length - 1])) parts.pop();
    }
    return parts.map(p => p.replace(/\.$/, '')).join(' ').replace(/"/g, '');
  }

  function splitName(raw) {
    const parts = cleanPersonName(raw).split(' ').filter(Boolean);
    if (!parts.length) return { firstName: '', lastName: '' };
    let i = parts.findIndex(p => !isInitial(p));
    if (i < 0) i = 0;
    const after = parts.slice(i + 1), before = parts.slice(0, i);
    const last = after.length ? after : before;
    return {
      firstName: smartCase(parts[i].replace(/\.$/, '')),
      lastName: last.map(smartCase).join(' '),
    };
  }

  function nameTokens(raw) { return words(cleanPersonName(raw)); }

  function nameSimilarity(leadName, resultName) {
    const a = nameTokens(leadName), b = nameTokens(resultName);
    if (!a.length || !b.length) return 0;
    if (a.join('') === b.join('')) return 1;
    const bSet = new Set(b);
    const bPairs = new Set();
    for (let j = 0; j + 1 < b.length; j++) bPairs.add(b[j] + b[j + 1]);
    const matched = a.map(() => 0);
    const neutral = a.map(() => false);
    const bHasInitials = b.some(x => x.length === 1);
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (matched[i]) continue;
      if (t.length === 1) {
        // Profiles often drop initials ("Banu A" -> "Banu"); only a different initial counts against.
        if (b.some(x => x[0] === t)) matched[i] = 1;
        else if (!bHasInitials) neutral[i] = true;
        continue;
      }
      if (bSet.has(t) || bPairs.has(t)) { matched[i] = 1; continue; }
      if (i + 1 < a.length && bSet.has(t + a[i + 1])) { matched[i] = 1; matched[i + 1] = 1; continue; }
      if (t.length >= 5 && b.some(x => x.length >= 5 && editDistanceAtMost1(t, x))) matched[i] = 0.85;
    }
    let total = 0, got = 0;
    a.forEach((t, i) => {
      if (neutral[i]) return;
      const w = t.length === 1 ? 0.5 : 1;
      total += w;
      got += w * matched[i];
    });
    if (!total) return 0;
    let score = got / total;
    // The first full word (normally the first name) must be present.
    const firstFull = a.findIndex(t => t.length > 1);
    if (firstFull >= 0 && !matched[firstFull]) score = Math.min(score, 0.5);
    // Small penalty for extra full words on the profile ("Sumit Kumar" vs "Sumit Kumar Singh").
    const aJoined = a.join('');
    const extra = b.filter(x => x.length > 1 && !a.includes(x) && !aJoined.includes(x)).length;
    score -= Math.min(0.15, 0.05 * extra);
    return Math.max(0, Math.min(1, score));
  }

  // ---------------------------------------------------------------- companies, titles, places

  const LEGAL_SUFFIX = /[\s,.]+(pvt|private|ltd|limited|llp|llc|l\.l\.c|inc|incorporated|corp|corporation|co|gmbh|plc|pte|pty|sa|ag|bv|nv|s\.a)\.?$/i;
  const GENERIC_ORG = new Set(('pvt private ltd limited llp llc inc corp corporation co the and of for '
    + 'technologies technology tech solutions services systems group global international india consulting '
    + 'labs lab media college university institute school hospital company enterprises industries ventures '
    + 'capital holdings partners associates software digital'). split(' '));
  const STOP = new Set('of and the & at for in to a an with on de la le du des y e'.split(' '));

  function stripLegal(company) {
    let s = normSpace(company), prev;
    do { prev = s; s = s.replace(LEGAL_SUFFIX, '').trim(); } while (s !== prev && s);
    return s || normSpace(company);
  }

  // Short company phrase that is safe to put in quotes.
  function companyForQuery(company) {
    const seg = stripLegal(company).split(/\s+\|\s+|\s*[|,(]\s*|\s+[-–—]\s+/)[0];
    return normSpace(seg).replace(/"/g, '');
  }

  function titleForQuery(title) {
    return normSpace(str(title).split(/\s*[|,(]\s*|\s+[-–—]\s+/)[0]).replace(/"/g, '');
  }

  function cityOf(location) {
    const first = normSpace(str(location).split(',')[0]);
    const city = first.replace(/^greater\s+/i, '')
      .replace(/\s+(metropolitan area|metropolitan region|metro area|metroplex|bay area|area|region)$/i, '');
    return normSpace(city).replace(/"/g, '');
  }

  const ABBR = {
    ceo: 'chief executive officer', cto: 'chief technology officer', cfo: 'chief financial officer',
    coo: 'chief operating officer', cmo: 'chief marketing officer', cio: 'chief information officer',
    cro: 'chief revenue officer', chro: 'chief human resources officer', clo: 'chief learning officer',
    vp: 'vice president', svp: 'senior vice president', evp: 'executive vice president',
    avp: 'assistant vice president', md: 'managing director', gm: 'general manager',
    hr: 'human resources', bd: 'business development', ops: 'operations', mgr: 'manager',
    sr: 'senior', jr: 'junior', dir: 'director', eng: 'engineering',
  };

  function expandWords(list) {
    const out = list.slice();
    list.forEach(w => { if (ABBR[w]) out.push(...ABBR[w].split(' ')); });
    return out;
  }

  function companySimilarity(company, hayString, hayWords) {
    const segs = stripLegal(company).split(/\s+\|\s+|\s*[|,(]\s*/).map(normSpace).filter(Boolean);
    let best = null;
    for (const seg of segs) {
      const w = words(seg).filter(x => !STOP.has(x));
      if (!w.length) continue;
      if (hayString.includes(' ' + w.join(' ') + ' ')) return 1;
      let total = 0, got = 0;
      w.forEach(x => {
        const weight = GENERIC_ORG.has(x) ? 0.4 : 1;
        total += weight;
        if (hayWords.has(x)) got += weight;
      });
      const score = got / total;
      if (best == null || score > best) best = score;
    }
    // Also accept the company written without spaces ("Code Krafters" vs "CodeKrafters").
    const squashed = words(stripLegal(company)).filter(x => !GENERIC_ORG.has(x)).join('');
    if (squashed.length >= 5 && hayString.replace(/ /g, '').includes(squashed)) return Math.max(best || 0, 0.9);
    return best;
  }

  // "CEO" counts as present when the profile says "Chief Executive Officer", and the other way round
  // (the profile side is expanded by the caller).
  function titleSimilarity(title, hayWords) {
    const w = uniq(words(title).filter(x => !STOP.has(x)));
    if (!w.length) return null;
    const hit = x => hayWords.has(x) || (!!ABBR[x] && ABBR[x].split(' ').every(y => hayWords.has(y)));
    return w.filter(hit).length / w.length;
  }

  function locationSimilarity(leadLocation, resultLocation, hayString) {
    const city = words(cityOf(leadLocation)).join(' ');
    const segs = str(leadLocation).split(',').slice(1).map(x => words(x).join(' ')).filter(Boolean);
    if (resultLocation) {
      const r = wordString(resultLocation);
      if (city && r.includes(' ' + city + ' ')) return 1;
      if (segs.some(sg => r.includes(' ' + sg + ' '))) return 0.5;
      return 0;
    }
    if (city && hayString.includes(' ' + city + ' ')) return 1;
    return null;
  }

  // ---------------------------------------------------------------- LinkedIn URLs and results

  function normalizeLinkedInUrl(u) {
    let url;
    try { url = new URL(normSpace(u)); } catch (e) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (!(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return null;
    const m = url.pathname.match(/^\/(in|pub)\/([^/]+)(\/.*)?$/i);
    if (!m) return null;
    let slug = m[2];
    try { slug = decodeURIComponent(slug); } catch (e) { /* keep raw slug */ }
    slug = normSpace(slug).toLowerCase();
    if (!slug) return null;
    if (m[1].toLowerCase() === 'pub') {
      if (slug === 'dir') return null;
      const rest = (m[3] || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
      return 'https://www.linkedin.com/pub/' + encodeURIComponent(slug) + (rest ? '/' + rest : '');
    }
    return 'https://www.linkedin.com/in/' + encodeURIComponent(slug);
  }

  // Pull name / headline / company / location out of one Google result for a LinkedIn profile.
  function parseProfileResult(res) {
    if (!res) return null;
    const url = normalizeLinkedInUrl(res.link || res.url || '');
    if (!url) return null;
    const rawTitle = normSpace(res.title);
    const title = rawTitle.replace(/\s*(\.\.\.|…)\s*$/, '').replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, '').trim();
    const parts = title.split(/\s+[-–—|]\s+/).map(normSpace).filter(Boolean);
    const snippet = normSpace(res.snippet);
    const extras = (Array.isArray(res.extras) ? res.extras : []).map(normSpace).filter(Boolean);
    let name = parts[0] || '';
    let headline = parts.slice(1).join(' - ');
    let jobTitle = parts.length >= 3 ? parts[1] : '';
    let company = parts.length >= 3 ? parts[parts.length - 1] : '';
    let location = '';
    const locM = snippet.match(/Location:\s*([^·•|]+?)(?:\s*[·•|]|\.\s|$)/i);
    if (locM) location = normSpace(locM[1]);
    const expM = snippet.match(/Experience:\s*([^·•|]+?)(?:\s*[·•|]|$)/i);
    if (expM && !company) company = normSpace(expM[1]).replace(/\.$/, '');
    extras.forEach(x => {
      if (!location && isLocation(x)) location = x;
      else if (!jobTitle && x !== location && TITLE_HINT.test(fold(x))) jobTitle = x;
      else if (!company && x !== location && x !== jobTitle) company = x;
    });
    if (!location) {
      const lead = snippet.split(/\s*[·•]\s*/)[0];
      if (lead && lead.length < 60 && isLocation(lead)) location = lead;
    }
    if (parts.length === 2 && !jobTitle && !company) {
      if (TITLE_HINT.test(fold(parts[1])) && !ORG_HINT.test(fold(parts[1]))) jobTitle = parts[1];
      else company = parts[1];
    }
    return {
      url, name, headline, title: jobTitle, company, location,
      resultTitle: rawTitle, snippet,
    };
  }

  // ---------------------------------------------------------------- matching

  const DEFAULT_MATCH = { matchMin: 75, reviewMin: 50 };

  function judgeResult(lead, res, opts) {
    const o = Object.assign({}, DEFAULT_MATCH, opts || {});
    const p = parseProfileResult(res);
    if (!p) return null;
    const hayText = [res.title, res.snippet].concat(Array.isArray(res.extras) ? res.extras : []).join(' ');
    const hayList = expandWords(words(hayText));
    const hayWords = new Set(hayList);
    const hayString = ' ' + hayList.join(' ') + ' ';
    const nameScore = nameSimilarity(lead.name, p.name);
    const companyScore = normSpace(lead.company) ? companySimilarity(lead.company, hayString, hayWords) : null;
    const titleScore = normSpace(lead.title) ? titleSimilarity(lead.title, hayWords) : null;
    const locScore = normSpace(lead.location) ? locationSimilarity(lead.location, p.location, hayString) : null;

    let num = 50 * nameScore, den = 50;
    if (companyScore != null) { num += 30 * companyScore; den += 30; }
    if (titleScore != null) { num += 10 * titleScore; den += 10; }
    if (locScore != null) { num += 10 * locScore; den += 10; }
    let confidence = Math.round((100 * num) / den);
    if (nameScore < 0.6) confidence = Math.min(confidence, 30);
    if (locScore === 0) confidence = Math.max(0, confidence - 10);

    const fullNameWords = nameTokens(lead.name).filter(t => t.length > 1).length;
    const hasCompany = !!normSpace(lead.company);
    const evidence = hasCompany
      ? (companyScore || 0) >= 0.6
      : (titleScore || 0) >= 0.5 || (fullNameWords >= 2 && locScore === 1);
    let verdict = 'No match';
    if (confidence >= o.matchMin && nameScore >= 0.85 && evidence) verdict = 'Matched';
    else if (confidence >= o.reviewMin && nameScore >= 0.6) verdict = 'Review';

    const why = [];
    why.push('name ' + Math.round(nameScore * 100) + '%');
    if (companyScore != null) why.push('company ' + Math.round(companyScore * 100) + '%');
    if (titleScore != null) why.push('title ' + Math.round(titleScore * 100) + '%');
    if (locScore != null) why.push('location ' + Math.round(locScore * 100) + '%');

    return Object.assign(p, {
      confidence, verdict, nameScore, companyScore, titleScore, locScore, why: why.join(', '),
    });
  }

  const VERDICT_RANK = { Matched: 2, Review: 1, 'No match': 0 };

  function rankCandidates(list) {
    return list.filter(Boolean).map((c, i) => Object.assign({ _i: i }, c)).sort((x, y) =>
      (VERDICT_RANK[y.verdict] - VERDICT_RANK[x.verdict]) || (y.confidence - x.confidence) || (x._i - y._i))
      .map(c => { delete c._i; return c; });
  }

  // Judge every result for one lead; keeps the best entry per profile URL.
  function evaluateResults(lead, results, opts) {
    const byUrl = new Map();
    (results || []).forEach(r => {
      const j = judgeResult(lead, r, opts);
      if (!j) return;
      const prev = byUrl.get(j.url);
      if (!prev || j.confidence > prev.confidence) byUrl.set(j.url, j);
    });
    return rankCandidates(Array.from(byUrl.values()));
  }

  // ---------------------------------------------------------------- queries

  const DEFAULT_TEMPLATES = [
    'site:linkedin.com/in/ "{name}" "{company}"',
    'site:linkedin.com/in/ "{name}" "{city}"',
    'site:linkedin.com/in/ "{name}"',
  ];

  function queryVars(lead) {
    const n = splitName(lead.name);
    return {
      name: searchName(lead.name),
      fullname: normSpace(lead.name).replace(/"/g, ''),
      first: n.firstName.replace(/"/g, ''),
      last: n.lastName.replace(/"/g, ''),
      company: companyForQuery(lead.company || ''),
      title: titleForQuery(lead.title || ''),
      city: cityOf(lead.location || ''),
      location: normSpace(lead.location).replace(/"/g, ''),
    };
  }

  // Returns null when the template uses a field this lead does not have.
  function fillTemplate(template, vars) {
    let missing = false;
    const out = str(template).replace(/\{(\w+)\}/g, (m, key) => {
      const k = key.toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(vars, k)) return m;
      if (!vars[k]) missing = true;
      return vars[k];
    });
    return missing ? null : normSpace(out);
  }

  function buildFindQueries(lead, templates) {
    const list = (Array.isArray(templates) ? templates : str(templates).split('\n')).map(normSpace).filter(Boolean);
    const vars = queryVars(lead);
    if (!vars.name) return [];
    return uniq(list.map(t => fillTemplate(t, vars)).filter(Boolean));
  }

  function lines(text) {
    return str(text).split(/\r?\n/).map(normSpace).filter(Boolean);
  }

  function quote(s) { return '"' + normSpace(s).replace(/"/g, '') + '"'; }

  function looseTerm(s) {
    const t = normSpace(s);
    if (/["()]|\bOR\b|^-|site:|intitle:|inurl:/.test(t)) return t;
    return quote(t);
  }

  // ---------------------------------------------------------------- lead search & company search

  // Seniority shortcuts: each ticked level adds these job titles to the lead search.
  const SENIORITY = {
    owner: ['Founder', 'Co-Founder', 'Owner'],
    cxo: ['CEO', 'COO', 'CFO', 'CTO', 'CMO', 'CIO'],
    vp: ['Vice President', 'VP'],
    director: ['Director'],
    head: ['Head'],
    manager: ['Manager'],
  };

  // Google country codes (gl) used by SerpApi / Serper.
  const COUNTRIES = [
    ['in', 'India'], ['us', 'United States'], ['uk', 'United Kingdom'], ['ca', 'Canada'], ['au', 'Australia'],
    ['ae', 'United Arab Emirates'], ['sg', 'Singapore'], ['sa', 'Saudi Arabia'], ['qa', 'Qatar'], ['de', 'Germany'],
    ['fr', 'France'], ['nl', 'Netherlands'], ['ie', 'Ireland'], ['es', 'Spain'], ['it', 'Italy'], ['nz', 'New Zealand'],
    ['za', 'South Africa'], ['ng', 'Nigeria'], ['ke', 'Kenya'], ['my', 'Malaysia'], ['ph', 'Philippines'],
    ['id', 'Indonesia'], ['jp', 'Japan'], ['br', 'Brazil'], ['mx', 'Mexico'],
  ];

  function countryName(code) {
    const c = COUNTRIES.find(x => x[0] === str(code).toLowerCase());
    return c ? c[1] : '';
  }

  const MAX_QUERIES = 5000;

  // Every combination of the term groups (first group outermost), capped at MAX_QUERIES.
  function combine(groups, limit) {
    let combos = [[]];
    for (const g of groups) {
      const opts = g.length ? g : [null];
      const next = [];
      for (const c of combos) {
        for (const x of opts) {
          if (next.length >= limit) break;
          next.push(c.concat([x]));
        }
      }
      combos = next;
    }
    return combos;
  }

  function leadTitleTerms(o) {
    const out = lines(o.titles);
    (Array.isArray(o.seniority) ? o.seniority : []).forEach(k => { (SENIORITY[k] || []).forEach(t => out.push(t)); });
    return uniq(out);
  }

  // Lead search ("X-ray"): designation x department x company x region x keyword, plus raw queries.
  // Returns [{query, meta}] - meta says which filter values went into the query.
  function buildLeadPlan(opts) {
    const o = opts || {};
    const site = normSpace(o.site) || 'site:linkedin.com/in/';
    const titles = leadTitleTerms(o);
    const functions = lines(o.functions), keywords = lines(o.keywords);
    const companies = uniq(lines(o.companies).map(companyForQuery).filter(Boolean));
    let locations = lines(o.locations);
    if (!locations.length && countryName(o.country)) locations = [countryName(o.country)];
    const excludes = uniq(str(o.excludes).split(/[\n,]/).map(normSpace).filter(Boolean));
    const exPart = excludes.map(e => '-' + quote(e)).join(' ');
    const titleGroup = titles.length > 1 && o.combineTitles
      ? [{ term: '(' + titles.map(quote).join(' OR ') + ')', value: titles.join(' / ') }]
      : titles.map(t => ({ term: looseTerm(t), value: t }));
    const groups = [
      titleGroup,
      functions.map(f => ({ term: quote(f), value: f })),
      companies.map(c => ({ term: quote(c), value: c })),
      locations.map(l => ({ term: quote(l), value: l })),
      keywords.map(k => ({ term: looseTerm(k), value: k })),
    ];
    const keys = ['title', 'func', 'company', 'location', 'keyword'];
    const out = [];
    if (groups.some(g => g.length)) {
      combine(groups, MAX_QUERIES).forEach(c => {
        const meta = {};
        c.forEach((x, i) => { if (x) meta[keys[i]] = x.value; });
        out.push({ query: normSpace([site].concat(c.map(x => (x ? x.term : '')), [exPart]).join(' ')), meta });
      });
    }
    lines(o.raw).forEach(q => out.push({ query: /\bsite:/i.test(q) ? q : normSpace(site + ' ' + q), meta: {} }));
    const seen = new Set();
    return out.filter(x => (seen.has(x.query) ? false : (seen.add(x.query), true))).slice(0, MAX_QUERIES);
  }

  function buildXrayQueries(opts) { return buildLeadPlan(opts).map(x => x.query); }

  // Company search: industry/keyword x location on LinkedIn company pages.
  function buildCompanyPlan(opts) {
    const o = opts || {};
    const site = 'site:linkedin.com/company/';
    const keywords = lines(o.keywords);
    let locations = lines(o.locations);
    if (!locations.length && countryName(o.country)) locations = [countryName(o.country)];
    const excludes = uniq(str(o.excludes).split(/[\n,]/).map(normSpace).filter(Boolean));
    const exPart = excludes.map(e => '-' + quote(e)).join(' ');
    const groups = [keywords.map(k => ({ term: looseTerm(k), value: k })), locations.map(l => ({ term: quote(l), value: l }))];
    const out = [];
    if (groups.some(g => g.length)) {
      combine(groups, MAX_QUERIES).forEach(c => {
        out.push({ query: normSpace([site].concat(c.map(x => (x ? x.term : '')), [exPart]).join(' ')),
          meta: { keyword: c[0] ? c[0].value : '', location: c[1] ? c[1].value : '' } });
      });
    }
    lines(o.raw).forEach(q => out.push({ query: /\bsite:/i.test(q) ? q : normSpace(site + ' ' + q), meta: {} }));
    const seen = new Set();
    return out.filter(x => (seen.has(x.query) ? false : (seen.add(x.query), true))).slice(0, MAX_QUERIES);
  }

  function hasAllWords(term, set) {
    const w = words(term).filter(x => !STOP.has(x));
    return w.length > 0 && w.every(x => set.has(x) || (!!ABBR[x] && ABBR[x].split(' ').every(y => set.has(y))));
  }

  // Checks one Google result against the lead search filters.
  // Each check is true (matches), false (does not match) or null (Google does not show it).
  function checkLeadFilters(res, opts) {
    const p = parseProfileResult(res);
    if (!p) return null;
    const o = opts || {};
    const extras = Array.isArray(res.extras) ? res.extras : [];
    const snippetLead = normSpace(str(res.snippet).split(/\s*[·•]\s*/)[0]);
    const headline = new Set(expandWords(words([p.headline, p.title, snippetLead].join(' '))));
    const checks = { title: null, func: null, company: null, location: null };
    let matchedCompany = '';
    const titles = leadTitleTerms(o);
    if (titles.length) checks.title = titles.some(t => hasAllWords(t, headline));
    const functions = lines(o.functions);
    if (functions.length) checks.func = functions.some(t => hasAllWords(t, headline));
    const companies = lines(o.companies);
    if (companies.length) {
      // "Current company only" looks at the headline and the Experience field, not the whole snippet.
      const text = o.currentOnly
        ? [p.headline, p.company, snippetLead].concat(extras).join(' ')
        : [res.title, res.snippet].concat(extras).join(' ');
      const list = expandWords(words(text));
      const set = new Set(list), hay = ' ' + list.join(' ') + ' ';
      checks.company = false;
      for (const c of companies) {
        const sc = companySimilarity(c, hay, set);
        if (sc != null && sc >= 0.6) { checks.company = true; matchedCompany = c; break; }
      }
    }
    const regions = lines(o.locations);
    const targets = (regions.length ? regions.map(cityOf) : [countryName(o.country)]).map(x => words(x).join(' ')).filter(Boolean);
    if (targets.length) {
      if (p.location) {
        const loc = wordString(p.location);
        checks.location = targets.some(t => loc.includes(' ' + t + ' '));
      } else {
        const hay = wordString([res.title, res.snippet].concat(extras).join(' '));
        checks.location = targets.some(t => hay.includes(' ' + t + ' ')) ? true : null;
      }
    }
    const names = { title: 'Title', func: 'Department', company: 'Company', location: 'Location' };
    const used = Object.keys(checks).filter(k => checks[k] !== null || (k === 'location' && targets.length));
    const label = used.map(k => names[k] + ' ' + (checks[k] === true ? '✓' : checks[k] === false ? '✗' : '?')).join(' · ');
    const pass = Object.keys(checks).every(k => checks[k] !== false);
    const strictPass = used.every(k => checks[k] === true);
    return { profile: p, checks, label, pass, strictPass, matchedCompany };
  }

  function normalizeCompanyUrl(u) {
    let url;
    try { url = new URL(normSpace(u)); } catch (e) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (!(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return null;
    const m = url.pathname.match(/^\/company\/([^/]+)/i);
    if (!m) return null;
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (e) { /* keep raw slug */ }
    slug = normSpace(slug).toLowerCase();
    return slug ? 'https://www.linkedin.com/company/' + encodeURIComponent(slug) : null;
  }

  const SIZE_BUCKETS = [['1-10', 1, 10], ['11-50', 11, 50], ['51-200', 51, 200], ['201-500', 201, 500],
    ['501-1000', 501, 1000], ['1001-5000', 1001, 5000], ['5001-10000', 5001, 10000], ['10001+', 10001, Infinity]];

  // "11-50 employees" -> "11-50"; "2-10" -> "1-10"; "1,234 employees" -> "1001-5000".
  function sizeBucket(sizeText) {
    const m = str(sizeText).replace(/,/g, '').match(/\d+/);
    if (!m) return '';
    const n = Number(m[0]);
    const b = SIZE_BUCKETS.find(x => n >= x[1] && n <= x[2]);
    return b ? b[0] : '';
  }

  function parseCompanyResult(res) {
    if (!res) return null;
    const url = normalizeCompanyUrl(res.link || res.url || '');
    if (!url) return null;
    const rawTitle = normSpace(res.title);
    let name = rawTitle.replace(/\s*(\.\.\.|…)\s*$/, '').replace(/\s*[|\-–—:]\s*LinkedIn\b.*$/i, '');
    name = normSpace(name.split(/\s+\|\s+/)[0]).replace(/\s*[:|-]\s*(overview|about|jobs|people|life|posts)$/i, '');
    if (!name || /^linkedin$/i.test(name)) {
      name = decodeURIComponent(url.split('/company/')[1] || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    }
    const text = [res.snippet].concat(Array.isArray(res.extras) ? res.extras : []).join(' · ');
    const grab = re => { const m = text.match(re); return m ? normSpace(m[1]).replace(/[.;,]$/, '') : ''; };
    const size = grab(/(\d[\d,]*\s*[-–]\s*\d[\d,]*|\d[\d,]*\+?)\s+employees/i);
    return {
      url, name,
      followers: grab(/(\d[\d.,]*\s*[KkMm]?)\+?\s+followers/i),
      size, sizeBucket: sizeBucket(size),
      industry: grab(/Industry:?\s*([^·•|;\n]+?)(?:\s*[·•|;]|\.\s|$)/i),
      hq: grab(/Headquarters:?\s*([^·•|;\n]+?)(?:\s*[·•|;]|\.\s|$)/i),
      website: grab(/Website:?\s*((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+[^\s·•|;]*)/i),
      resultTitle: rawTitle, snippet: normSpace(res.snippet),
    };
  }

  function googleUrl(query) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(query);
  }

  // ---------------------------------------------------------------- Sales Navigator parser

  const SELECT_RE = /^select\s+(?!all\b)(.+)$/i;
  const PIC_RE = /^(.+?)['’`]s?\s+profile (?:picture|photo|image)$/i;
  const VIEW_RE = /^view\s+(.+?)['’`]s?\s+profile$/i;
  const DEGREE_RE = /^(?:[·•]\s*)?(1st|2nd|3rd\+?)$|^(first|second|third)[- ]degree connection$/i;
  const STOP_RE = /^(add note|edit note|view note|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})$/i;
  const NOISE = [
    /^select all\b/i,
    /profile (picture|photo|image)$/i,
    /^view .+ profile$/i,
    /^(?:[·•]\s*)?(1st|2nd|3rd\+?)$/i,
    /^(first|second|third)[- ]degree connection$/i,
    /^out of network$/i,
    /^\d+\s+lists?$/i,
    /^saved( badge| lead)?$/i,
    /^\(\+\d+\)$/,
    /^\+\d+$/,
    /^(add|edit|view) note$/i,
    /^no activity$/i,
    /^add account$/i,
    /^open the account matching modal/i,
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
    /^(name|account|geography|notes?( tooltip)?|outreach activity|date added|actions|lead|leads|accounts|title|company|location)$/i,
    /^(message|save|unsave|view profile|see more|show more|show less|show all|see all|add to list|more|remove|connect|follow|following|pending|inmail|send inmail|view in sales navigator|save to list|more actions|open menu|dismiss|hide|undo|select|selected|deselect|next|previous|back|close)$/i,
    /\b\d+\s+(years?|months?|yrs?|mos?)\b.*\bin (role|company|position)\b/i,
    /^(about|past|summary|recent activity|shared|education)\s*:/i,
    /\bmutual connections?\b/i,
    /\bconnections? in common\b/i,
    /^(recently (hired|promoted|posted|changed jobs?)|changed jobs|posted on linkedin|viewed your profile|shared experiences?|teamlink.*|open to work|hiring|premium( member)?|new|top lead|\d+ (new )?alerts?|in the news|following your company|engaged with your company)$/i,
    /\b(ago|yesterday|today)$/i,
    /^(last active|active)\b/i,
    /^showing \d+/i,
    /^\d[\d,]*\s+(results?|leads?|accounts?)$/i,
    /^page \d+( of \d+)?$/i,
    /^\d+$/,
    /\blogo$/i,
    /^(status|reached out|replied|messaged|contacted|not contacted|no reply)$/i,
  ];

  function isNoise(text) { return NOISE.some(re => re.test(text)); }

  function looksLikeName(s) {
    const t = normSpace(s);
    if (t.length < 2 || t.length > 80 || /\d|@|https?:|[|•·:]/.test(t)) return false;
    if (!/\p{L}/u.test(t)) return false;
    const f = fold(t);
    if (f.split(' ').length > 7 || isNoise(t)) return false;
    if (ORG_HINT.test(f) || TITLE_HINT.test(f) || isLocation(t)) return false;
    return true;
  }

  // Splits raw text into lines; tab-separated cells become separate lines. `tab` marks a cell end.
  function rawLines(text) {
    const out = [];
    str(text).replace(/\r\n?/g, '\n').split('\n').forEach(raw => {
      const cells = raw.split('\t');
      cells.forEach((cell, i) => {
        out.push({ text: normSpace(cell), tab: i < cells.length - 1 });
      });
    });
    return out;
  }

  function anchorName(text) {
    let m = text.match(PIC_RE);
    if (m) return { kind: 'pic', name: normSpace(m[1]) };
    m = text.match(VIEW_RE);
    if (m) return { kind: 'view', name: normSpace(m[1]) };
    m = text.match(SELECT_RE);
    if (m) return { kind: 'select', name: normSpace(m[1]) };
    return null;
  }

  function findAnchors(L) {
    const byKind = { select: [], pic: [], view: [] };
    L.forEach((ln, i) => {
      const a = ln.text && anchorName(ln.text);
      if (!a || !a.name) return;
      if (a.kind === 'select') {
        // A real checkbox label is followed by the same name or that person's picture.
        let ok = false;
        for (let k = i + 1, seen = 0; k < L.length && seen < 4; k++) {
          if (!L[k].text) continue;
          seen++;
          const next = anchorName(L[k].text);
          if (fold(L[k].text) === fold(a.name) || (next && next.kind !== 'select' && fold(next.name) === fold(a.name))) { ok = true; break; }
        }
        if (!ok) return;
      }
      byKind[a.kind].push({ index: i, name: a.name });
    });
    if (byKind.select.length) return byKind.select;
    if (byKind.pic.length) return byKind.pic;
    return byKind.view;
  }

  function assignFields(content) {
    const L = content.slice();
    let location = '';
    let locIdx = -1;
    for (let i = L.length - 1; i >= 0; i--) {
      if (L[i].tab && isLocation(L[i].text)) { locIdx = i; break; }
    }
    if (locIdx < 0) {
      for (let i = L.length - 1; i >= (L.length === 1 ? 0 : 1); i--) {
        if (isLocation(L[i].text)) { locIdx = i; break; }
      }
    }
    if (locIdx >= 0) { location = L[locIdx].text; L.splice(locIdx, 1); }
    let title = L[0] ? L[0].text : '';
    let company = L[1] ? L[1].text : '';
    title = title.replace(/^(current( role)?|title|headline|position)\s*:\s*/i, '');
    if (!company && title) {
      const at = title.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
      const dot = title.match(/^(.+?)\s+[·•]\s+(.+)$/);
      if (at) { title = normSpace(at[1]); company = normSpace(at[2]); }
      else if (dot) { title = normSpace(dot[1]); company = normSpace(dot[2]); }
    }
    company = company.replace(/^(company|account|current company)\s*:\s*/i, '');
    return { title, company, location };
  }

  function parseAnchored(L, anchors) {
    const knownNames = new Set(anchors.map(a => fold(a.name)));
    const leads = [];
    anchors.forEach((a, n) => {
      const end = n + 1 < anchors.length ? anchors[n + 1].index : L.length;
      const content = [];
      let degree = '';
      for (let k = a.index + 1; k < end; k++) {
        const ln = L[k];
        if (!ln.text) continue;
        if (STOP_RE.test(ln.text)) break;
        const dm = ln.text.match(DEGREE_RE);
        if (dm) {
          if (!degree) degree = dm[1] ? dm[1].toLowerCase() : { first: '1st', second: '2nd', third: '3rd' }[dm[2].toLowerCase()];
          continue;
        }
        if (knownNames.has(fold(ln.text))) continue;
        const an = anchorName(ln.text);
        if (an && knownNames.has(fold(an.name))) continue;
        if (isNoise(ln.text)) continue;
        if (ln.text.length > 160) continue; // "About" paragraphs
        content.push(ln);
      }
      const f = assignFields(content);
      leads.push({ name: a.name, title: f.title, company: f.company, location: f.location, degree, url: '' });
    });
    return leads;
  }

  function parseCsvText(text, delim) {
    const rows = [];
    let row = [], cell = '', q = false;
    const s = str(text).replace(/\r\n?/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => normSpace(c)));
  }

  const HEADER_MAP = [
    ['firstName', /^first ?name$/],
    ['lastName', /^(last ?name|surname)$/],
    ['name', /^(full ?name|name|lead ?name|contact ?name|person)$/],
    ['url', /(linkedin|profile ?url|^url$|^profile$)/],
    ['title', /(job ?title|^title$|position|headline|designation|^role$)/],
    ['company', /(company|account|organi[sz]ation|employer)/],
    ['location', /(location|geography|^city$|region|country)/],
  ];

  function parseTable(text) {
    const first = str(text).split(/\r?\n/).find(l => normSpace(l)) || '';
    const delim = first.includes('\t') ? '\t' : (first.split(',').length >= first.split(';').length ? ',' : ';');
    const rows = parseCsvText(text, delim);
    if (rows.length < 2) return null;
    const header = rows[0].map(h => fold(h));
    const col = {};
    header.forEach((h, i) => {
      for (const [key, re] of HEADER_MAP) {
        if (col[key] == null && re.test(h)) { col[key] = i; break; }
      }
    });
    if (col.name == null && col.firstName == null) return null;
    return rows.slice(1).map(r => {
      const get = k => (col[k] == null ? '' : normSpace(r[col[k]]));
      const name = get('name') || normSpace(get('firstName') + ' ' + get('lastName'));
      return { name, title: get('title'), company: get('company'), location: get('location'), degree: '', url: normalizeLinkedInUrl(get('url')) || '' };
    }).filter(l => l.name && !isNoise(l.name) && !/\d|@|https?:/.test(l.name));
  }

  function parsePipes(text) {
    return lines(text).filter(l => l.includes('|')).map(l => {
      const cells = l.replace(/^\[|\]$/g, '').split('|').map(normSpace);
      return { name: cells[0] || '', title: cells[1] || '', company: cells[2] || '', location: cells[3] || '', degree: '', url: '' };
    }).filter(l => looksLikeName(l.name));
  }

  function parseBlocks(text) {
    const blocks = str(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/);
    const leads = [];
    blocks.forEach(b => {
      const L = rawLines(b).filter(x => x.text);
      if (!L.length || !looksLikeName(L[0].text)) return;
      const name = L[0].text;
      const content = L.slice(1).filter(x => fold(x.text) !== fold(name) && !isNoise(x.text) && x.text.length <= 160);
      const f = assignFields(content);
      leads.push({ name, title: f.title, company: f.company, location: f.location, degree: '', url: '' });
    });
    return leads;
  }

  function leadKey(lead) {
    return words(cleanPersonName(lead.name)).join(' ') + '|' + words(stripLegal(lead.company || '')).join(' ');
  }

  function finishLead(l) {
    const n = splitName(l.name);
    return {
      name: normSpace(l.name), firstName: n.firstName, lastName: n.lastName,
      title: normSpace(l.title), company: normSpace(l.company), location: normSpace(l.location),
      degree: l.degree || '', url: l.url || '',
    };
  }

  function parseLeads(text) {
    const result = { leads: [], mode: 'none', duplicates: 0, skipped: 0 };
    if (!normSpace(text)) return result;
    const L = rawLines(text);
    let leads = null;
    const anchors = findAnchors(L);
    if (anchors.length) {
      result.mode = 'sales-navigator';
      leads = parseAnchored(L, anchors);
    }
    if (!leads) {
      const firstLine = (str(text).split(/\r?\n/).find(l => normSpace(l)) || '').toLowerCase();
      if (/(^|[\t,;"])\s*(full ?name|name|first ?name)\s*($|[\t,;"])/.test(firstLine)) {
        const t = parseTable(text);
        if (t && t.length) { result.mode = 'table'; leads = t; }
      }
    }
    if (!leads) {
      const ls = lines(text);
      if (ls.length && ls.filter(l => l.includes('|')).length >= Math.max(1, ls.length * 0.5)) {
        result.mode = 'pipe';
        leads = parsePipes(text);
      }
    }
    if (!leads) {
      result.mode = 'blocks';
      leads = parseBlocks(text);
    }
    const seen = new Set();
    leads.forEach(l => {
      if (!normSpace(l.name) || !/\p{L}/u.test(l.name)) { result.skipped++; return; }
      const key = leadKey(l);
      if (seen.has(key)) { result.duplicates++; return; }
      seen.add(key);
      result.leads.push(finishLead(l));
    });
    return result;
  }

  // ---------------------------------------------------------------- CSV / Excel

  function csvCell(v) {
    let s = str(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(columns, rows) {
    const out = [columns.map(c => csvCell(c.label)).join(',')];
    rows.forEach(r => out.push(columns.map(c => csvCell(r[c.key])).join(',')));
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  function toTSV(columns, rows) {
    const clean = v => str(v).replace(/[\t\r\n]+/g, ' ');
    return [columns.map(c => clean(c.label)).join('\t')]
      .concat(rows.map(r => columns.map(c => clean(r[c.key])).join('\t'))).join('\n');
  }

  function xmlEscape(s) {
    return str(s)
      .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function colName(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Minimal ZIP writer (stored, no compression) - enough for an .xlsx package.
  function zipFiles(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const DOS_TIME = 0, DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
    files.forEach(f => {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, DOS_TIME, true); local.setUint16(12, DOS_DATE, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true); cd.setUint16(12, DOS_TIME, true); cd.setUint16(14, DOS_DATE, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true); cd.setUint16(36, 0, true); cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
      chunks.push(new Uint8Array(local.buffer), name, data);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let p = 0;
    all.forEach(c => { out.set(c, p); p += c.length; });
    return out;
  }

  // columns: [{key, label, type: 'text'|'number'|'url', width}]
  function toXLSX(columns, rows, sheetName) {
    const sheet = (normSpace(sheetName) || 'Leads').replace(/[\\/?*[\]:']/g, ' ').slice(0, 31).trim() || 'Leads';
    const lastCol = colName(Math.max(columns.length, 1) - 1);
    const lastRow = rows.length + 1;
    const links = [];
    const cell = (ref, value, type, style) => {
      const v = str(value);
      if (type === 'number' && v !== '' && isFinite(Number(v))) return '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '') + '><v>' + Number(v) + '</v></c>';
      if (v === '') return '';
      const text = v.length > 32000 ? v.slice(0, 32000) : v;
      return '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') + '><is><t xml:space="preserve">' + xmlEscape(text) + '</t></is></c>';
    };
    const body = [];
    body.push('<row r="1">' + columns.map((c, i) => cell(colName(i) + '1', c.label, 'text', 1)).join('') + '</row>');
    rows.forEach((r, ri) => {
      const rn = ri + 2;
      const cells = columns.map((c, ci) => {
        const ref = colName(ci) + rn;
        const v = str(r[c.key]);
        if (c.type === 'url' && /^https?:\/\/[^\s"<>]+$/i.test(v) && v.length < 2000 && links.length < 60000) {
          links.push({ ref, target: v });
          return cell(ref, v, 'text', 2);
        }
        return cell(ref, v, c.type, 0);
      });
      body.push('<row r="' + rn + '">' + cells.join('') + '</row>');
    });
    const cols = columns.map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 18) + '" customWidth="1"/>').join('');
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet ' + NS + '>'
      + '<dimension ref="A1:' + lastCol + lastRow + '"/>'
      + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + (cols ? '<cols>' + cols + '</cols>' : '')
      + '<sheetData>' + body.join('') + '</sheetData>'
      + '<autoFilter ref="A1:' + lastCol + lastRow + '"/>'
      + (links.length ? '<hyperlinks>' + links.map((l, i) => '<hyperlink ref="' + l.ref + '" r:id="rIdL' + (i + 1) + '"/>').join('') + '</hyperlinks>' : '')
      + '</worksheet>';
    const sheetRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + links.map((l, i) => '<Relationship Id="rIdL' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEscape(l.target) + '" TargetMode="External"/>').join('')
      + '</Relationships>';
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook ' + NS + '><sheets><sheet name="' + xmlEscape(sheet) + '" sheetId="1" r:id="rId1"/></sheets>'
      + '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\''
      + xmlEscape(sheet) + '\'!$A$1:$' + lastCol + '$' + lastRow + '</definedName></definedNames></workbook>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
      + '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FF0A66C2"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
      + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>';
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>';
    const files = [
      { name: '[Content_Types].xml', data: types },
      { name: '_rels/.rels', data: rootRels },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
      { name: 'xl/styles.xml', data: styles },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    ];
    if (links.length) files.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: sheetRels });
    return zipFiles(files);
  }

  return {
    normSpace, fold, words, isLocation, cleanPersonName, searchName, splitName, nameSimilarity,
    stripLegal, companyForQuery, titleForQuery, cityOf, normalizeLinkedInUrl, parseProfileResult,
    judgeResult, evaluateResults, rankCandidates, DEFAULT_TEMPLATES, queryVars, fillTemplate,
    buildFindQueries, buildXrayQueries, buildLeadPlan, buildCompanyPlan, checkLeadFilters, SENIORITY, COUNTRIES,
    countryName, normalizeCompanyUrl, parseCompanyResult, sizeBucket, SIZE_BUCKETS, googleUrl, parseLeads, leadKey, looksLikeName,
    toCSV, toTSV, toXLSX, zipFiles, crc32, colName,
  };
});
