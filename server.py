#!/usr/bin/env python3
"""LinkedIn Lead Finder - local server.

Serves the app on http://127.0.0.1:8765 and forwards Google searches to SerpApi or
Serper.dev (the browser cannot call those APIs directly because of CORS).
Uses only the Python standard library: nothing to pip install.

    python server.py               start and open the browser
    python server.py --port 9000   use another port
    python server.py --no-browser  do not open the browser
"""

import argparse
import hashlib
import http.client
import ipaddress
import json
import os
import random
import re
import socket
import sqlite3
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import webbrowser
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2.5.0"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
DATA_DIR = os.environ.get("LLF_DATA_DIR") or os.path.join(APP_DIR, "data")
SERPAPI_BASE = os.environ.get("LLF_SERPAPI_URL", "https://serpapi.com").rstrip("/")
SERPER_BASE = os.environ.get("LLF_SERPER_URL", "https://google.serper.dev").rstrip("/")
HUNTER_BASE = os.environ.get("LLF_HUNTER_URL", "https://api.hunter.io").rstrip("/")
APOLLO_BASE = os.environ.get("LLF_APOLLO_URL", "https://api.apollo.io").rstrip("/")
FULLENRICH_BASE = os.environ.get("LLF_FULLENRICH_URL", "https://app.fullenrich.com").rstrip("/")
PROVIDERS = ("serpapi", "serper", "mock")
CONTACT_PROVIDERS = ("free", "hunter", "apollo", "fullenrich", "mock")
KEYED = ("serpapi", "serper", "hunter", "apollo", "fullenrich")
ENV_KEYS = {"serpapi": "SERPAPI_KEY", "serper": "SERPER_API_KEY", "hunter": "HUNTER_API_KEY",
            "apollo": "APOLLO_API_KEY", "fullenrich": "FULLENRICH_API_KEY"}
NAMES = {"serpapi": "SerpApi", "serper": "Serper", "hunter": "Hunter", "apollo": "Apollo", "fullenrich": "FullEnrich",
         "mock": "Mock mode", "free": "Free (websites + Google)"}
UPSTREAM_TIMEOUT = 30
RETRY_DELAYS = (1.5, 4.0)
MAX_STATE_BYTES = 80 * 1024 * 1024
MAX_BODY_BYTES = 256 * 1024

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}

_lock = threading.Lock()
_stats = {"api_calls": 0, "cache_hits": 0}


def log(msg):
    try:
        print(time.strftime("%H:%M:%S") + "  " + msg, flush=True)
    except Exception:
        pass


# ------------------------------------------------------------------ config & storage

def ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def _config_path():
    return os.path.join(DATA_DIR, "config.json")


def load_config():
    cfg = {"provider": "serpapi", "contactProvider": "free", "keys": dict((k, "") for k in KEYED)}
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            saved = json.load(f)
        if saved.get("provider") in PROVIDERS:
            cfg["provider"] = saved["provider"]
        if saved.get("contactProvider") in CONTACT_PROVIDERS:
            cfg["contactProvider"] = saved["contactProvider"]
        for k in KEYED:
            if isinstance(saved.get("keys", {}).get(k), str):
                cfg["keys"][k] = saved["keys"][k]
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg):
    ensure_data_dir()
    write_atomic(_config_path(), json.dumps(cfg, indent=2))


def api_key(cfg, provider):
    env = os.environ.get(ENV_KEYS.get(provider, ""), "").strip()
    return env or cfg["keys"].get(provider, "").strip()


def mask(key):
    if not key:
        return ""
    return key[:4] + "..." + key[-4:] if len(key) > 10 else "****"


_write_lock = threading.Lock()


def write_atomic(path, text):
    with _write_lock:
        tmp = "%s.%d.tmp" % (path, threading.get_ident())
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        # Windows: antivirus or indexing can hold the file for a moment, so retry briefly.
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.2)


class Cache:
    """Remembers search results so repeating a query does not spend credits."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.db = None

    def _conn(self):
        if self.db is None:
            ensure_data_dir()
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            self.db.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, created REAL, body TEXT)")
            self.db.commit()
        return self.db

    @staticmethod
    def key(provider, query, page, gl, hl):
        raw = "\x1f".join([provider, query, str(page), gl, hl])
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def get(self, key, max_age_days):
        if max_age_days <= 0:
            return None
        with self.lock:
            try:
                row = self._conn().execute("SELECT created, body FROM cache WHERE key = ?", (key,)).fetchone()
            except sqlite3.Error:
                return None
        if not row or time.time() - row[0] > max_age_days * 86400:
            return None
        try:
            return json.loads(row[1])
        except ValueError:
            return None

    def put(self, key, value):
        with self.lock:
            try:
                self._conn().execute("INSERT OR REPLACE INTO cache (key, created, body) VALUES (?, ?, ?)",
                                     (key, time.time(), json.dumps(value)))
                self._conn().commit()
            except sqlite3.Error as e:
                log("cache write failed: %s" % e)

    def clear(self):
        with self.lock:
            try:
                self._conn().execute("DELETE FROM cache")
                self._conn().commit()
            except sqlite3.Error:
                pass


CACHE = None


# ------------------------------------------------------------------ upstream search providers

class SearchError(Exception):
    def __init__(self, message, fatal=False, retryable=False, status=0):
        Exception.__init__(self, message)
        self.message = message
        self.fatal = fatal
        self.retryable = retryable
        self.status = status


FATAL_WORDS = re.compile(r"invalid api key|api key is invalid|unauthori[sz]ed|run out of searches|out of searches|"
                         r"not enough credits|no credits|exhausted|account (is )?(disabled|suspended)|"
                         r"plan (has )?expired|missing api key|api key (is )?(missing|required)", re.I)
CREDIT_WORDS = re.compile(r"insufficient credit|not enough credit|credits? (are |is )?(exhausted|insufficient|depleted)|"
                          r"usage limit|usage_limit|usage_exceeded|exceeded your (monthly |plan )?(usage|limit|quota)|"
                          r"upgrade your plan|no (more )?credits|out of credits|credits_insufficient", re.I)
NO_RESULTS = re.compile(r"hasn't returned any results|has not returned any results|no results", re.I)


def http_json(url, data=None, headers=None, method=None):
    """Returns (status, parsed_json_or_None, raw_text)."""
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"))
    req.add_header("User-Agent", "LinkedInLeadFinder/" + VERSION)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        resp = urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT)
        status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read() or b""
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
            raise SearchError("SSL certificate check failed. On a Mac run 'Install Certificates.command' from your "
                              "Python folder; on a work network ask IT about HTTPS inspection. (%s)" % reason,
                              fatal=True)
        raise SearchError("Cannot reach the search service - check your internet connection. (%s)" % reason,
                          retryable=True)
    except (socket.timeout, TimeoutError):
        raise SearchError("The search service did not answer within %d seconds." % UPSTREAM_TIMEOUT, retryable=True)
    except OSError as e:
        raise SearchError("Network error: %s" % e, retryable=True)
    text = raw.decode("utf-8", "replace")
    try:
        parsed = json.loads(text) if text.strip() else None
    except ValueError:
        parsed = None
    return status, parsed, text


def upstream_error(provider, status, parsed, text):
    msg = ""
    if isinstance(parsed, dict):
        msg = parsed.get("error") or parsed.get("message") or parsed.get("detail") or ""
        errors = parsed.get("errors")
        if not msg and isinstance(errors, list) and errors and isinstance(errors[0], dict):
            msg = errors[0].get("details") or errors[0].get("message") or errors[0].get("id") or ""
        if isinstance(msg, (dict, list)):
            msg = json.dumps(msg)[:200]
    msg = str(msg or text[:200] or ("HTTP %d" % status)).strip()
    name = NAMES.get(provider, provider)
    fatal = status in (401, 402, 403) or bool(FATAL_WORDS.search(msg)) or bool(CREDIT_WORDS.search(msg))
    retryable = not fatal and (status == 429 or status >= 500 or status == 0)
    if fatal and status in (401, 403) and "key" not in msg.lower():
        msg += " - check the API key in Settings."
    return SearchError("%s: %s" % (name, msg), fatal=fatal, retryable=retryable, status=status)


def knowledge_panel(kg):
    """Google's knowledge panel often names the official website of a company."""
    if not isinstance(kg, dict):
        return None
    website = kg.get("website") or ""
    if not website and isinstance(kg.get("source"), dict):
        website = kg["source"].get("link") or ""
    if not isinstance(website, str) or not website.startswith("http"):
        website = ""
    phone = kg.get("phone") or kg.get("phoneNumber") or ""
    attrs = kg.get("attributes") if isinstance(kg.get("attributes"), dict) else {}
    for k, v in attrs.items():
        if not phone and isinstance(v, str) and re.search(r"phone|customer service", str(k), re.I):
            phone = v
    if not isinstance(phone, str):
        phone = ""
    if not website and not phone:
        return None
    return {"title": str(kg.get("title") or ""), "website": website, "phone": phone.strip()[:40]}


def search_serpapi(key, query, page, gl, hl):
    params = {"engine": "google", "q": query, "api_key": key, "start": str((page - 1) * 10)}
    if gl:
        params["gl"] = gl
    if hl:
        params["hl"] = hl
    status, data, text = http_json(SERPAPI_BASE + "/search.json?" + urllib.parse.urlencode(params))
    if status != 200 or not isinstance(data, dict):
        raise upstream_error("serpapi", status, data, text)
    err = data.get("error")
    if err:
        if NO_RESULTS.search(str(err)):
            return [], False, None
        raise upstream_error("serpapi", status, data, text)
    results = []
    for r in data.get("organic_results") or []:
        extras = []
        rich = r.get("rich_snippet") or {}
        for part in ("top", "bottom"):
            ext = (rich.get(part) or {}).get("extensions")
            if isinstance(ext, list):
                extras.extend(str(x) for x in ext)
        results.append({"title": r.get("title") or "", "link": r.get("link") or "",
                        "snippet": r.get("snippet") or "", "extras": extras})
    pagination = data.get("serpapi_pagination") or data.get("pagination") or {}
    return results, bool(pagination.get("next")), knowledge_panel(data.get("knowledge_graph"))


def search_serper(key, query, page, gl, hl):
    body = {"q": query, "num": 10, "page": page}
    if gl:
        body["gl"] = gl
    if hl:
        body["hl"] = hl
    status, data, text = http_json(SERPER_BASE + "/search", data=body, headers={"X-API-KEY": key})
    if status != 200 or not isinstance(data, dict):
        raise upstream_error("serper", status, data, text)
    if data.get("message") and not data.get("organic"):
        raise upstream_error("serper", status, data, text)
    results = []
    for r in data.get("organic") or []:
        attrs = r.get("attributes") or {}
        extras = [str(v) for v in attrs.values()] if isinstance(attrs, dict) else []
        results.append({"title": r.get("title") or "", "link": r.get("link") or "",
                        "snippet": r.get("snippet") or "", "extras": extras})
    return results, len(results) >= 8, knowledge_panel(data.get("knowledgeGraph"))


# ---- mock provider: fake but realistic results, no credits, for testing the whole flow

MOCK_FIRST = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Isha", "Vikram", "Ananya", "Arjun", "Priya",
              "Liam", "Olivia", "Noah", "Emma", "Mateo", "Sofia", "Ethan", "Ava", "Lucas", "Mia"]
MOCK_LAST = ["Sharma", "Iyer", "Reddy", "Nair", "Menon", "Kapoor", "Rao", "Pillai", "Das", "Bose",
             "Smith", "Johnson", "Garcia", "Brown", "Lee", "Martin", "Clark", "Lopez", "Young", "Hall"]


def _h(text):
    return int(hashlib.md5(text.encode("utf-8")).hexdigest(), 16)


def _slug(text):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "profile"


def search_mock(query, page, mode, meta=None):
    time.sleep(0.12)
    meta = meta if isinstance(meta, dict) else {}
    phrases = re.findall(r'"([^"]+)"', query)
    noise = [
        {"title": "Posts | LinkedIn", "link": "https://www.linkedin.com/posts/mock-post-%d" % (_h(query) % 9999),
         "snippet": "A LinkedIn post (should be ignored by the matcher).", "extras": []},
        {"title": "Mock Company | LinkedIn", "link": "https://www.linkedin.com/company/mock-company",
         "snippet": "Company page (should be ignored).", "extras": []},
    ]
    if mode == "web" and '"@' in query:
        domain = re.search(r'"@([^"]+)"', query).group(1)
        h = _h("emails|" + domain)
        if h % 3 == 2:
            return [], False, None
        return [{"title": "Contact - %s" % domain, "link": "https://www.%s/contact" % domain,
                 "snippet": "Email sales@%s or alex.morgan@%s for quotes. Directory listing (mock)." % (domain, domain),
                 "extras": []}], False, {"title": domain, "website": "", "phone": "+1 (737) 555-%04d" % (h % 10000)}
    if mode == "web":
        company = str(meta.get("company") or (phrases[0] if phrases else "Mock Company"))
        h = _h("web|" + company)
        site = "https://www.%s.com" % re.sub(r"[^a-z0-9]", "", company.lower())
        out = [{"title": "%s | Facebook" % company, "link": "https://www.facebook.com/%s" % _slug(company),
                "snippet": "Social page (should be ignored).", "extras": []}]
        if h % 4 != 3:
            out.append({"title": "%s - Official Site" % company, "link": site + "/", "snippet": "Welcome to %s." % company,
                        "extras": []})
        if h % 2 == 0:
            out.append({"title": "%s | LinkedIn" % company, "link": "https://www.linkedin.com/company/%s" % _slug(company),
                        "snippet": "%s | %d followers on LinkedIn. Industry: Services · Company size: 51-200 employees · "
                                   "Headquarters: Dallas, Texas" % (company, h % 9000), "extras": []})
        kg = {"title": company, "website": site} if h % 3 == 0 else None
        return out, False, kg
    if mode == "company" and meta.get("company"):
        company = str(meta["company"])
        h = _h("page|" + company)
        if h % 5 == 4:
            return [], False
        return [{"title": "%s | LinkedIn" % company, "link": "https://www.linkedin.com/company/%s" % _slug(company),
                 "snippet": "%s | %d followers on LinkedIn. Industry: Services · Company size: 201-500 employees · "
                            "Headquarters: Austin, Texas · Website: https://www.%s.com" % (
                                company, h % 9000, re.sub(r"[^a-z0-9]", "", company.lower())), "extras": []},
                {"title": "Other Mock Holdings | LinkedIn", "link": "https://www.linkedin.com/company/other-mock-holdings",
                 "snippet": "Another company (should not be picked).", "extras": []}], False
    if mode == "company":
        if page > 5:
            return [], False
        keyword = str(meta.get("keyword") or (phrases[0] if phrases else "Business"))
        place = str(meta.get("location") or (phrases[1] if len(phrases) > 1 else "Chennai, Tamil Nadu"))
        sizes = ["2-10", "11-50", "51-200", "201-500", "1,001-5,000", ""]
        out = []
        for i in range(10):
            h = _h("company|%s|%d|%d" % (query, page, i))
            name = "Mock %s %s %d" % (keyword.title(), ["Solutions", "Group", "Works", "Labs", "Partners"][h % 5], h % 997)
            size = sizes[h % len(sizes)]
            out.append({
                "title": "%s | LinkedIn" % name,
                "link": "https://www.linkedin.com/company/%s" % _slug(name),
                "snippet": "%s | %d followers on LinkedIn. A made-up %s company for testing. | Industry: %s%s · Headquarters: %s" % (
                    name, h % 20000, keyword, keyword.title(),
                    (" · Company size: %s employees" % size) if size else "", place),
                "extras": [],
            })
        noise_person = {"title": "Someone - Mock | LinkedIn", "link": "https://www.linkedin.com/in/mock-person",
                        "snippet": "A person page (should be ignored by company search).", "extras": []}
        return out + [noise_person], page < 5
    if mode == "xray":
        if page > 5:
            return [], False
        title = str(meta.get("title") or (phrases[0] if phrases else "Professional"))
        place = str(meta.get("location") or "Chennai, Tamil Nadu, India")
        out = []
        for i in range(10):
            h = _h("%s|%d|%d" % (query, page, i))
            name = "%s %s" % (MOCK_FIRST[h % len(MOCK_FIRST)], MOCK_LAST[(h // 7) % len(MOCK_LAST)])
            company = str(meta.get("company") or "Mock %s Pvt Ltd" % ["Systems", "Labs", "Foods", "Logistics", "Health"][h % 5])
            ptitle, ploc = title, place
            if i % 5 == 4:
                # someone who only mentions the search words: other job, other company, other city
                ptitle, company, ploc = "Software Engineer", "Other Mock Corp", "Pune, Maharashtra, India"
            out.append({
                "title": "%s - %s - %s | LinkedIn" % (name, ptitle, company),
                "link": "https://in.linkedin.com/in/mock-%s-%x" % (_slug(name), h % 0xFFFFF),
                "snippet": "%s at %s · Experience: %s · Location: %s · 500+ connections on LinkedIn." % (
                    ptitle, company, company, ploc),
                "extras": [ploc, ptitle, company],
            })
        return out + noise[:1], page < 5
    if not phrases or page > 1:
        return [], False
    name = phrases[0]
    other = phrases[1] if len(phrases) > 1 else ""
    bucket = _h(name) % 10
    if bucket < 6:
        hits = [{
            "title": "%s - %s | LinkedIn" % (name, other or "Mock Profile"),
            "link": "https://in.linkedin.com/in/mock-%s-%x" % (_slug(name), _h(name) % 0xFFFF),
            "snippet": "%s · 500+ connections on LinkedIn. View %s's profile on LinkedIn." % (other or "Mock Profile", name),
            "extras": [],
        }]
    elif bucket < 8:
        # same name at another company: once with a different city (-> not found), once without (-> review)
        hits = [{
            "title": "%s - Some Other Company Pvt Ltd | LinkedIn" % name,
            "link": "https://www.linkedin.com/in/mock-%s-other" % _slug(name),
            "snippet": "Experience: Some Other Company · %s300 connections on LinkedIn." % (
                "Location: Mumbai · " if bucket == 6 else ""),
            "extras": [],
        }]
    else:
        hits = []
    return hits + noise, False


def run_search(cfg, payload):
    provider = cfg["provider"]
    query = str(payload.get("query") or "").strip()
    if not query:
        raise SearchError("Empty search query.")
    if len(query) > 2000:
        raise SearchError("Search query is too long (max 2000 characters).")
    try:
        page = max(1, min(100, int(payload.get("page") or 1)))
        cache_days = float(payload.get("cacheDays", 30))
    except (TypeError, ValueError):
        raise SearchError("Bad page or cacheDays value.")
    gl = re.sub(r"[^a-z]", "", str(payload.get("gl") or "").lower())[:2]
    hl = re.sub(r"[^a-zA-Z-]", "", str(payload.get("hl") or ""))[:8]
    mode = payload.get("mode") if payload.get("mode") in ("xray", "company", "web") else "find"

    if provider == "mock":
        found = search_mock(query, page, mode, payload.get("meta"))
        return {"ok": True, "results": found[0], "hasMore": found[1], "kg": found[2] if len(found) > 2 else None,
                "cached": False, "provider": "mock"}

    key = api_key(cfg, provider)
    if not key:
        raise SearchError("No API key saved for %s. Open Settings, paste your key and click Save."
                          % ("SerpApi" if provider == "serpapi" else "Serper"), fatal=True)
    ckey = Cache.key(provider, query, page, gl, hl)
    hit = CACHE.get(ckey, cache_days)
    if hit is not None:
        with _lock:
            _stats["cache_hits"] += 1
        return {"ok": True, "results": hit["results"], "hasMore": hit["hasMore"], "kg": hit.get("kg"),
                "cached": True, "provider": provider}

    fn = search_serpapi if provider == "serpapi" else search_serper
    attempt = 0
    while True:
        try:
            results, has_more, kg = fn(key, query, page, gl, hl)
            break
        except SearchError as e:
            if e.retryable and attempt < len(RETRY_DELAYS):
                time.sleep(RETRY_DELAYS[attempt] * (1 + random.random() * 0.3))
                attempt += 1
                continue
            raise
    with _lock:
        _stats["api_calls"] += 1
    CACHE.put(ckey, {"results": results, "hasMore": has_more, "kg": kg})
    return {"ok": True, "results": results, "hasMore": has_more, "kg": kg, "cached": False, "provider": provider}


def test_provider(cfg):
    provider = cfg["provider"]
    if provider == "mock":
        return {"ok": True, "message": "Mock mode is on: searches are simulated and cost nothing. "
                                       "Results are fake - switch to SerpApi or Serper for real profiles."}
    key = api_key(cfg, provider)
    if not key:
        return {"ok": False, "message": "No API key saved yet."}
    try:
        if provider == "serpapi":
            status, data, text = http_json(SERPAPI_BASE + "/account.json?" + urllib.parse.urlencode({"api_key": key}))
            if status != 200 or not isinstance(data, dict) or data.get("error"):
                raise upstream_error("serpapi", status, data, text)
            left = data.get("total_searches_left", data.get("plan_searches_left"))
            plan = data.get("plan_name") or data.get("plan_id") or ""
            msg = "SerpApi key works."
            if left is not None:
                msg += " Searches left: %s." % left
            if plan:
                msg += " Plan: %s." % plan
            return {"ok": True, "message": msg, "searchesLeft": left}
        results = search_serper(key, 'site:linkedin.com/in/ "software engineer"', 1, "", "")[0]
        with _lock:
            _stats["api_calls"] += 1
        return {"ok": True, "message": "Serper key works (this test used 1 search, %d results)." % len(results)}
    except SearchError as e:
        return {"ok": False, "message": e.message}


# ------------------------------------------------------------------ email & phone finders

def unexpected(provider, text):
    return SearchError("%s sent a reply this tool does not understand - please send this to support: %s"
                       % (NAMES[provider], (text or "(empty)")[:200]))


def clean_person(raw):
    if not isinstance(raw, dict):
        raise SearchError("Bad person data.")
    out = {}
    for k in ("id", "first", "last", "full", "company", "domain", "linkedin"):
        v = raw.get(k)
        out[k] = re.sub(r"\s+", " ", str(v)).strip()[:200] if v is not None else ""
    out["domain"] = re.sub(r"^https?://(www\.)?", "", out["domain"].lower()).split("/")[0]
    if not out["first"] and not out["full"]:
        raise SearchError("A name is needed to look up contact details.")
    return out


def hunter_find(key, p, want):
    params = {"first_name": p["first"], "last_name": p["last"]}
    if not p["last"]:
        params = {"full_name": p["full"] or p["first"]}
    if p["domain"]:
        params["domain"] = p["domain"]
    elif p["company"]:
        params["company"] = p["company"]
    else:
        return {"email": "", "note": "No company or website to search with"}
    status, data, text = http_json(HUNTER_BASE + "/v2/email-finder?" + urllib.parse.urlencode(params),
                                   headers={"X-API-KEY": key})
    if status == 404:
        return {"email": ""}
    if status != 200 or not isinstance(data, dict):
        raise upstream_error("hunter", status, data, text)
    d = data.get("data")
    if d is None:
        return {"email": ""}
    if not isinstance(d, dict):
        raise unexpected("hunter", text)
    ver = d.get("verification") if isinstance(d.get("verification"), dict) else {}
    email = d.get("email") or ""
    score = d.get("score")
    status_text = ver.get("status") or ("score %s" % score if email and score is not None else "")
    return {"email": email, "emailStatus": status_text, "phone": (d.get("phone_number") or "") if want.get("phone") else "",
            "title": d.get("position") or ""}


def apollo_match(key, p, want):
    body = {}
    for src, dst in (("first", "first_name"), ("last", "last_name"), ("company", "organization_name"),
                     ("domain", "domain"), ("linkedin", "linkedin_url")):
        if p[src]:
            body[dst] = p[src]
    if not p["last"] and p["full"]:
        body["name"] = p["full"]
    status, data, text = http_json(APOLLO_BASE + "/api/v1/people/match", data=body,
                                   headers={"x-api-key": key, "Cache-Control": "no-cache"})
    if status != 200 or not isinstance(data, dict):
        raise upstream_error("apollo", status, data, text)
    if "person" not in data:
        raise unexpected("apollo", text)
    person = data.get("person") if isinstance(data.get("person"), dict) else {}
    email = person.get("email") or ""
    if "not_unlocked" in email or email.lower().endswith("@domain.com"):
        email = ""  # Apollo's placeholder for an email that was not revealed
    phone = ""
    if want.get("phone"):
        for ph in person.get("phone_numbers") or []:
            if isinstance(ph, dict) and (ph.get("sanitized_number") or ph.get("raw_number")):
                phone = ph.get("sanitized_number") or ph.get("raw_number")
                break
    return {"email": email, "emailStatus": person.get("email_status") or "", "phone": phone,
            "title": person.get("title") or ""}


def _pick(value, field):
    """FullEnrich's most_probable_* can be an object ({email, status} / {number, region}) or a plain string."""
    if isinstance(value, dict):
        return value.get(field) or "", value.get("status") or ""
    if isinstance(value, str):
        return value, ""
    return "", ""


FULLENRICH_RUNNING = ("IN_PROGRESS", "CREATED", "QUEUED", "PENDING", "PROCESSING", "RUNNING", "STARTED")


def fullenrich_start(key, people, want):
    fields = []
    if want.get("email"):
        fields.append("contact.work_emails")
    if want.get("phone"):
        fields.append("contact.phones")
    data = []
    for p in people:
        item = {"enrich_fields": fields, "custom": {"lpf_id": p["id"]}}
        for src, dst in (("first", "first_name"), ("last", "last_name"), ("domain", "domain"),
                         ("company", "company_name"), ("linkedin", "linkedin_url")):
            if p[src]:
                item[dst] = p[src]
        data.append(item)
    body = {"name": "LPF " + time.strftime("%Y-%m-%d %H:%M"), "data": data}
    status, parsed, text = http_json(FULLENRICH_BASE + "/api/v2/contact/enrich/bulk", data=body,
                                     headers={"Authorization": "Bearer " + key})
    if status not in (200, 201, 202) or not isinstance(parsed, dict):
        raise upstream_error("fullenrich", status, parsed, text)
    job = parsed.get("enrichment_id") or parsed.get("id")
    if not job:
        raise unexpected("fullenrich", text)
    return str(job)


def fullenrich_poll(key, job):
    if not re.match(r"^[A-Za-z0-9_-]{1,100}$", job):
        raise SearchError("Bad job id.")
    status, parsed, text = http_json(FULLENRICH_BASE + "/api/v2/contact/enrich/bulk/" + job,
                                     headers={"Authorization": "Bearer " + key})
    if status != 200 or not isinstance(parsed, dict):
        raise upstream_error("fullenrich", status, parsed, text)
    state = str(parsed.get("status") or "").upper()
    if state in FULLENRICH_RUNNING:
        return {"done": False, "status": state, "results": []}
    if "CREDIT" in state:
        raise SearchError("FullEnrich: not enough credits to finish (status %s)." % state, fatal=True)
    items = parsed.get("data") if isinstance(parsed.get("data"), list) else parsed.get("datas")
    if not isinstance(items, list):
        if state == "FINISHED":
            raise unexpected("fullenrich", text)
        return {"done": True, "status": state, "results": []}
    results = []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        custom = it.get("custom") if isinstance(it.get("custom"), dict) else {}
        info = it.get("contact_info") or it.get("contact") or {}
        if not isinstance(info, dict):
            info = {}
        email, email_status = _pick(info.get("most_probable_work_email") or info.get("most_probable_email"), "email")
        if not email_status:
            email_status = info.get("most_probable_email_status") or ""
        phone = _pick(info.get("most_probable_phone"), "number")[0]
        results.append({"id": str(custom.get("lpf_id") or ""), "index": i, "email": email,
                        "emailStatus": email_status, "phone": phone})
    return {"done": True, "status": state, "results": results}




def mock_contact(p, want):
    time.sleep(0.05)
    h = _h("contact|" + p["first"] + "|" + p["last"] + "|" + p["company"])
    out = {"email": "", "emailStatus": "", "phone": ""}
    domain = p["domain"] or (re.sub(r"[^a-z0-9]", "", p["company"].lower()) + ".com" if p["company"] else "")
    if want.get("email") and domain and h % 10 < 7:
        local = re.sub(r"[^a-z0-9.]", "", (p["first"] + "." + p["last"]).lower()).strip(".") or "contact"
        out["email"] = "%s@%s" % (local, domain)
        out["emailStatus"] = "valid (mock)"
    if want.get("phone") and h % 10 < 4:
        out["phone"] = "+1 555 01%02d" % (h % 100)
    return out


def contact_one(cfg, payload):
    provider = cfg["contactProvider"]
    want = payload.get("want") if isinstance(payload.get("want"), dict) else {}
    want = {"email": bool(want.get("email")), "phone": bool(want.get("phone"))}
    p = clean_person(payload.get("person"))
    if provider == "mock":
        return dict(mock_contact(p, want), ok=True, provider="mock")
    if provider in ("fullenrich", "free"):
        raise SearchError("This finder works per company - reload the page and try again.")
    key = api_key(cfg, provider)
    if not key:
        raise SearchError("No API key saved for %s. Open Settings > Email & phone finder, paste your key and click Save."
                          % NAMES[provider], fatal=True)
    fn = hunter_find if provider == "hunter" else apollo_match
    attempt = 0
    while True:
        try:
            found = fn(key, p, want)
            break
        except SearchError as e:
            if e.retryable and attempt < len(RETRY_DELAYS):
                time.sleep(RETRY_DELAYS[attempt] * (1 + random.random() * 0.3))
                attempt += 1
                continue
            raise
    with _lock:
        _stats["contact_calls"] = _stats.get("contact_calls", 0) + 1
    return dict(found, ok=True, provider=provider)


def contact_batch_start(cfg, payload):
    if cfg["contactProvider"] != "fullenrich":
        raise SearchError("Batches are only used with FullEnrich.")
    key = api_key(cfg, "fullenrich")
    if not key:
        raise SearchError("No API key saved for FullEnrich. Open Settings > Email & phone finder, paste your key "
                          "and click Save.", fatal=True)
    people = payload.get("people")
    if not isinstance(people, list) or not 1 <= len(people) <= 100:
        raise SearchError("Send between 1 and 100 people per batch.")
    want = payload.get("want") if isinstance(payload.get("want"), dict) else {}
    want = {"email": bool(want.get("email")), "phone": bool(want.get("phone"))}
    if not want["email"] and not want["phone"]:
        raise SearchError("Nothing to look up.")
    return {"ok": True, "job": fullenrich_start(key, [clean_person(x) for x in people], want)}


def contact_batch_poll(cfg, payload):
    key = api_key(cfg, "fullenrich")
    if not key:
        raise SearchError("No API key saved for FullEnrich.", fatal=True)
    return dict(fullenrich_poll(key, str(payload.get("job") or "")), ok=True)


def test_contact_provider(cfg):
    provider = cfg["contactProvider"]
    if provider == "mock":
        return {"ok": True, "message": "Mock mode: emails and phone numbers are made up and cost nothing."}
    if provider == "free":
        return {"ok": True, "message": "Free mode needs no key: it reads company websites and uses your Google search provider."}
    key = api_key(cfg, provider)
    if not key:
        return {"ok": False, "message": "No API key saved yet."}
    try:
        if provider == "hunter":
            status, data, text = http_json(HUNTER_BASE + "/v2/account", headers={"X-API-KEY": key})
            if status != 200 or not isinstance(data, dict):
                raise upstream_error("hunter", status, data, text)
            d = data.get("data") if isinstance(data.get("data"), dict) else {}
            searches = ((d.get("requests") or {}).get("searches") or {}) if isinstance(d.get("requests"), dict) else {}
            msg = "Hunter key works."
            if searches.get("available") is not None:
                msg += " Searches used: %s of %s." % (searches.get("used", "?"), searches.get("available"))
            return {"ok": True, "message": msg}
        if provider == "apollo":
            status, data, text = http_json(APOLLO_BASE + "/v1/auth/health", headers={"x-api-key": key})
            if status == 200 and isinstance(data, dict) and data.get("is_logged_in") is not False:
                return {"ok": True, "message": "Apollo key works."}
            if status in (401, 403) or (isinstance(data, dict) and data.get("is_logged_in") is False):
                raise upstream_error("apollo", 401 if status == 200 else status, data, text or "Invalid API key")
            return {"ok": True, "message": "Apollo answered (HTTP %d) but could not confirm the key - "
                                           "try a 1-lead test." % status}
        for path in ("/api/v2/account/credits", "/api/v1/account/credits"):
            status, data, text = http_json(FULLENRICH_BASE + path, headers={"Authorization": "Bearer " + key})
            if status == 200 and isinstance(data, dict):
                bal = data.get("balance", data.get("credits"))
                return {"ok": True, "message": "FullEnrich key works." + (" Credits left: %s." % bal if bal is not None else "")}
            if status in (401, 403):
                raise upstream_error("fullenrich", status, data, text)
        return {"ok": True, "message": "FullEnrich answered but could not confirm the key - try a 1-lead test."}
    except SearchError as e:
        return {"ok": False, "message": e.message}


# ------------------------------------------------------------------ free contact finder: company websites

SITE_AGENT = "LPF-LeadFinder"
SITE_UA = "Mozilla/5.0 (compatible; %s/%s; reads public contact pages)" % (SITE_AGENT, VERSION)
SITE_PAGE_BYTES = 1500000
SITE_PAGE_TIMEOUT = 10
SITE_BUDGET_SECONDS = 45
ALLOW_PRIVATE_FETCH = os.environ.get("LLF_ALLOW_PRIVATE_FETCH") == "1"  # tests only
DOH_URLS = [u for u in (os.environ.get("LLF_DOH_URL"), "https://dns.google/resolve",
                        "https://cloudflare-dns.com/dns-query") if u]
CONTACT_LINK = re.compile(r"contact|about|team|leadership|management|people|staff|who-we-are|our-company|executive|"
                          r"board|founder|our-story|directory|kontakt|impressum|meet", re.I)
FALLBACK_PATHS = ("/contact", "/contact-us", "/about", "/about-us", "/team", "/our-team", "/leadership")
EMAIL_TEXT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}")
PHONE_TEXT = re.compile(r"(?:phone|tel|telephone|call(?: us)?|mobile|cell|office|direct|main|ph)\.?\s*(?:no\.?|number)?\s*[:\-]?\s*"
                        r"(\+?\(?\d[\d\s().\-]{6,20}\d)", re.I)
JUNK_EMAIL = re.compile(r"\.(png|jpe?g|gif|svg|webp|css|js)$|@(example|domain|email|sentry|sentry-next|wixpress|"
                        r"yourdomain|yoursite|company|mysite|test)\.|^(name|email|your|user|someone|firstname|"
                        r"first\.last|john\.doe|jane\.doe)@", re.I)


class FetchBlocked(Exception):
    pass


def host_is_public(host):
    """Never read pages on this computer or the local network (a website could redirect there)."""
    if ALLOW_PRIVATE_FETCH:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        return False
    for info in infos:
        try:
            if not ipaddress.ip_address(info[4][0].split("%")[0]).is_global:
                return False
        except ValueError:
            return False
    return bool(infos)


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 4

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme not in ("http", "https") or not u.hostname or not host_is_public(u.hostname):
            raise FetchBlocked("redirect to a private or invalid address")
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


_site_opener = urllib.request.build_opener(_SafeRedirect)


def fetch_page(url, deadline, want="html"):
    """Returns (final_url, text) or None. Only public addresses, limited size and time."""
    left = deadline - time.time()
    if left < 1:
        return None
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or not host_is_public(u.hostname):
        return None
    req = urllib.request.Request(url, headers={"User-Agent": SITE_UA, "Accept": "text/html,application/xhtml+xml,text/plain"})
    try:
        resp = _site_opener.open(req, timeout=max(1, min(SITE_PAGE_TIMEOUT, left)))
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if want == "html" and "html" not in ctype:
            return None
        raw = resp.read(SITE_PAGE_BYTES)
        charset = resp.headers.get_content_charset() or "utf-8"
        try:
            text = raw.decode(charset, "replace")
        except LookupError:
            text = raw.decode("utf-8", "replace")
        return resp.geturl(), text
    except (urllib.error.URLError, http.client.HTTPException, socket.timeout, TimeoutError, OSError, FetchBlocked,
            ValueError):
        return None


def decode_cfemail(hexstr):
    """Cloudflare hides emails as data-cfemail="<hex>"; the first byte is the XOR key."""
    try:
        data = bytes.fromhex(hexstr.strip())
        return bytes(b ^ data[0] for b in data[1:]).decode("utf-8", "replace")
    except (ValueError, IndexError):
        return ""


class _PageParser(HTMLParser):
    BLOCK = {"p", "div", "li", "tr", "td", "th", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
             "header", "footer", "address", "dd", "dt", "ul", "ol", "table"}

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.parts, self.links, self.mailto, self.tel, self.cf, self.ld = [], [], [], [], [], []
        self.size = 0  # characters of text so far, so link-hidden emails keep their position
        self._skip = 0
        self._in_ld = False
        self._a = None

    def handle_starttag(self, tag, attrs):
        a = dict((k, v or "") for k, v in attrs)
        if tag in ("script", "style", "noscript", "svg", "template"):
            if tag == "script" and "ld+json" in a.get("type", "").lower():
                self._in_ld = True
            else:
                self._skip += 1
            return
        if a.get("data-cfemail"):
            self.cf.append((a["data-cfemail"], self.size))
        if tag in self.BLOCK:
            self._add("\n")
        if tag == "a":
            href = a.get("href", "").strip()
            low = href.lower()
            if low.startswith("mailto:"):
                self.mailto.append((urllib.parse.unquote(href[7:].split("?")[0]), self.size))
            elif low.startswith("tel:"):
                self.tel.append(urllib.parse.unquote(href[4:]))
            elif "/cdn-cgi/l/email-protection#" in low:
                self.cf.append((href.split("#", 1)[1], self.size))
            elif href:
                self._a = [href, []]
                self.links.append(self._a)

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg", "template"):
            if tag == "script" and self._in_ld:
                self._in_ld = False
            elif self._skip:
                self._skip -= 1
            return
        if tag == "a":
            self._a = None
        if tag in self.BLOCK:
            self._add("\n")

    def _add(self, text):
        self.parts.append(text)
        self.size += len(text)

    def handle_data(self, data):
        if self._in_ld:
            self.ld.append(data)
            return
        if self._skip:
            return
        self._add(data)
        if self._a is not None:
            self._a[1].append(data)


def _deobfuscate(text):
    t = re.sub(r"\s*[\[\(\{<]\s*(?:at|@)\s*[\]\)\}>]\s*", "@", text, flags=re.I)
    t = re.sub(r"\s*[\[\(\{<]\s*dot\s*[\]\)\}>]\s*", ".", t, flags=re.I)
    return t


def _context(text, start, end, width=130):
    return re.sub(r"\s+", " ", text[max(0, start - width):end + width].replace("\n", " | ")).strip()[:400]


def _clean_email(e):
    e = urllib.parse.unquote(e or "").strip().strip(".,;:()<>[]'\"").lower()
    if not EMAIL_TEXT.fullmatch(e) or JUNK_EMAIL.search(e) or len(e) > 120:
        return ""
    return e


def _clean_phone(raw):
    p = re.sub(r"[^\d+()\-.\s]", "", raw or "").strip(" .-")
    digits = re.sub(r"\D", "", p)
    if not 7 <= len(digits) <= 15 or len(set(digits)) < 3:
        return ""
    return re.sub(r"\s+", " ", p)


def extract_contacts(html_text, page_url):
    parser = _PageParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:  # broken HTML: keep what was read
        pass
    raw_text = "".join(parser.parts)
    text = re.sub(r"[ \t\r\f\v\u00a0]+", " ", raw_text)
    text = re.sub(r"\n\s*(\n\s*)+", "\n", text)
    plain = _deobfuscate(text)
    emails, phones = {}, {}

    def add_email(raw, ctx):
        e = _clean_email(raw)
        if e and e not in emails:
            emails[e] = {"email": e, "page": page_url, "context": ctx}

    def add_phone(raw, ctx, kind):
        ph = _clean_phone(raw)
        key = re.sub(r"\D", "", ph)[-10:]
        if ph and key not in phones:
            phones[key] = {"number": ph, "page": page_url, "context": ctx, "kind": kind}

    for m in EMAIL_TEXT.finditer(plain):
        add_email(m.group(0), _context(plain, m.start(), m.end()))
    for raw, at in parser.mailto:
        add_email(raw, _context(raw_text, at, at))
    for h, at in parser.cf:
        add_email(decode_cfemail(h), _context(raw_text, at, at))
    for block in parser.ld:
        for m in re.finditer(r'"email"\s*:\s*"([^"]+)"', block):
            add_email(m.group(1).replace("mailto:", ""), "")
        for m in re.finditer(r'"telephone"\s*:\s*"([^"]+)"', block):
            add_phone(m.group(1), "", "listed")
    for raw in parser.tel:
        digits = re.sub(r"\D", "", raw)[-7:]
        ctx = ""
        for m in re.finditer(r"\+?\(?\d[\d\s().\-]{6,20}\d", plain):
            if re.sub(r"\D", "", m.group(0)).endswith(digits):
                ctx = _context(plain, m.start(), m.end())
                break
        add_phone(raw, ctx, "listed")
    for m in PHONE_TEXT.finditer(plain):
        if re.search(r"fax", plain[max(0, m.start() - 12):m.start() + 6], re.I):
            continue
        add_phone(m.group(1), _context(plain, m.start(1), m.end(1)), "text")
    links = [(urllib.parse.urljoin(page_url, href), " ".join("".join(t).split())[:80]) for href, t in parser.links]
    return list(emails.values()), list(phones.values()), links


def _same_site(url, host):
    h = (urllib.parse.urlparse(url).hostname or "").lower()
    strip = lambda x: x[4:] if x.startswith("www.") else x
    return strip(h) == strip(host) or h.endswith("." + strip(host))


def scan_site(domain, max_pages=6, budget=SITE_BUDGET_SECONDS):
    deadline = time.time() + budget
    home = None
    for start in ("https://%s/" % domain, "https://www.%s/" % domain, "http://%s/" % domain):
        if start.startswith("https://www.www."):
            continue
        home = fetch_page(start, deadline)
        if home:
            break
    result = {"reachable": bool(home), "pages": [], "emails": [], "phones": [], "robotsBlocked": 0}
    if not home:
        return result
    home_url, home_html = home
    host = urllib.parse.urlparse(home_url).hostname or domain
    origin = "%s://%s" % (urllib.parse.urlparse(home_url).scheme, urllib.parse.urlparse(home_url).netloc)
    robots = urllib.robotparser.RobotFileParser()
    got = fetch_page(origin + "/robots.txt", deadline, want="text")
    robots.parse(got[1].splitlines() if got and len(got[1]) < 500000 else [])
    allowed = lambda url: robots.can_fetch(SITE_AGENT, url)
    if not allowed(home_url):
        result["robotsBlocked"] = 1
        return result
    seen_e, seen_p = {}, {}

    def take(url, html_text):
        result["pages"].append(url)
        emails, phones, links = extract_contacts(html_text, url)
        for e in emails:
            seen_e.setdefault(e["email"], e)
        for ph in phones:
            seen_p.setdefault(re.sub(r"\D", "", ph["number"])[-10:], ph)
        return links

    links = take(home_url, home_html)
    ranked, queued = [], set([home_url.rstrip("/")])
    for url, label in links:
        clean = url.split("#")[0].rstrip("/")
        if not clean or clean in queued or not _same_site(clean, host) or re.search(r"\.(pdf|jpe?g|png|gif|zip|docx?)$", clean, re.I):
            continue
        hit = CONTACT_LINK.search(urllib.parse.urlparse(clean).path) or CONTACT_LINK.search(label)
        if hit:
            word = hit.group(0).lower()
            score = 0 if word.startswith(("contact", "kontakt")) else 1 if word in ("team", "leadership", "management", "people", "staff", "executive", "board", "meet") else 2
            ranked.append((score, clean))
            queued.add(clean)
    ranked.sort()
    todo = [u for _, u in ranked]
    if len(todo) < 2:
        todo += [origin + p for p in FALLBACK_PATHS if (origin + p) not in queued]
    for url in todo:
        if len(result["pages"]) >= max_pages or time.time() > deadline:
            break
        if not allowed(url):
            result["robotsBlocked"] += 1
            continue
        page = fetch_page(url, deadline)
        if page and _same_site(page[0], host):
            take(page[0], page[1])
    result["emails"] = list(seen_e.values())[:60]
    result["phones"] = list(seen_p.values())[:20]
    return result


def mx_check(domain):
    """Can this domain receive email? Asked through public DNS-over-HTTPS (free). None = could not check."""
    for base in DOH_URLS:
        try:
            status, data, _ = http_json(base + "?" + urllib.parse.urlencode({"name": domain, "type": "MX"}),
                                        headers={"Accept": "application/dns-json"})
        except SearchError:
            continue
        if status != 200 or not isinstance(data, dict) or "Status" not in data:
            continue
        if data.get("Status") == 3:
            return False
        answers = [a for a in data.get("Answer") or [] if isinstance(a, dict) and a.get("type") == 15]
        if not answers:
            return False
        return not all(str(a.get("data", "")).strip() in ("0 .", "0") for a in answers)
    return None


def mock_scan(domain, names):
    time.sleep(0.05)
    h = _h("site|" + domain)
    out = {"reachable": True, "pages": ["https://www.%s/" % domain, "https://www.%s/contact" % domain],
           "emails": [], "phones": [], "robotsBlocked": 0, "mx": h % 7 != 6}
    if h % 5 == 4:
        return dict(out, reachable=False, pages=[], mx=None)
    out["emails"].append({"email": "info@%s" % domain, "page": out["pages"][1], "context": "Contact us | info@%s" % domain})
    out["phones"].append({"number": "+1 (512) 555-%04d" % (h % 10000), "page": out["pages"][1],
                          "context": "Call us: +1 (512) 555-%04d" % (h % 10000), "kind": "listed"})
    for i, name in enumerate(names[:5]):
        parts = [x for x in re.split(r"\s+", re.sub(r"[^A-Za-z\s]", "", name)) if x]
        if len(parts) >= 2 and (h + i) % 2 == 0:
            local = "%s.%s" % (parts[0].lower(), parts[-1].lower())
            out["emails"].append({"email": "%s@%s" % (local, domain), "page": "https://www.%s/team" % domain,
                                  "context": "%s | Leadership | %s@%s" % (name, local, domain)})
    return out


def site_scan(cfg, payload):
    domain = str(payload.get("domain") or "").strip().lower()
    domain = re.sub(r"^https?://", "", domain).split("/")[0]
    if domain.startswith("www."):
        domain = domain[4:]
    if not re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$", domain) or len(domain) > 200:
        raise SearchError("That is not a website address.")
    if ":" in domain and not ALLOW_PRIVATE_FETCH:
        raise SearchError("That is not a website address.")
    names = [str(n)[:100] for n in (payload.get("names") or [])[:50] if isinstance(n, str)]
    if cfg["provider"] == "mock":
        return dict(mock_scan(domain, names), ok=True, cached=False, domain=domain)
    try:
        max_pages = max(1, min(15, int(payload.get("maxPages") or 6)))
        cache_days = float(payload.get("cacheDays", 30))
    except (TypeError, ValueError):
        raise SearchError("Bad maxPages or cacheDays value.")
    ckey = Cache.key("site-scan-v1", domain, max_pages, "", "")
    hit = CACHE.get(ckey, cache_days)
    if hit is not None:
        return dict(hit, ok=True, cached=True, domain=domain)
    found = scan_site(domain, max_pages)
    found["mx"] = mx_check(domain.split(":")[0])
    CACHE.put(ckey, found)
    return dict(found, ok=True, cached=False, domain=domain)


# ------------------------------------------------------------------ HTTP handler

class Handler(BaseHTTPRequestHandler):
    server_version = "LeadFinder/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep the console readable; errors are logged explicitly

    # -- helpers
    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        unread_body = self.command == "POST" and not getattr(self, "_body_read", False)
        self.send_response(status)
        if unread_body:
            # The request body was not consumed, so this connection cannot be reused safely.
            self.send_header("Connection", "close")
            self.close_connection = True
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj))

    def _host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        return name in ("127.0.0.1", "localhost", "[::1]")

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            u = urllib.parse.urlparse(origin)
        except ValueError:
            return False
        return u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost") and u.port == self.server.server_port

    def _read_json(self, limit):
        length = self.headers.get("Content-Length")
        try:
            n = int(length)
        except (TypeError, ValueError):
            raise SearchError("Missing Content-Length.")
        if n > limit:
            # drain so the connection stays usable, then refuse
            remaining = n
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._body_read = True
            raise SearchError("Request is too large.")
        raw = self.rfile.read(n) if n else b""
        self._body_read = True
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            raise SearchError("Request body is not valid JSON.")
        if not isinstance(data, dict):
            raise SearchError("Request body must be a JSON object.")
        return data

    # -- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, "Forbidden host", "text/plain; charset=utf-8")
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            return self._api_get(path)
        return self._static(path)

    def do_POST(self):
        self._body_read = False
        if not self._host_ok() or not self._origin_ok():
            return self._json(403, {"ok": False, "error": "Forbidden: requests must come from the Lead Finder page."})
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json" or self.headers.get("X-LLF") != "1":
            return self._json(403, {"ok": False, "error": "Forbidden: missing app header."})
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/search":
                payload = self._read_json(MAX_BODY_BYTES)
                try:
                    return self._json(200, run_search(load_config(), payload))
                except SearchError as e:
                    if e.fatal or e.status:
                        log("search error: %s" % e.message)
                    return self._json(200, {"ok": False, "error": e.message, "fatal": e.fatal,
                                            "retryable": e.retryable})
            if path in ("/api/contact", "/api/contact/start", "/api/contact/poll"):
                payload = self._read_json(MAX_BODY_BYTES)
                fn = {"/api/contact": contact_one, "/api/contact/start": contact_batch_start,
                      "/api/contact/poll": contact_batch_poll}[path]
                try:
                    return self._json(200, fn(load_config(), payload))
                except SearchError as e:
                    if e.fatal or e.status:
                        log("contact lookup error: %s" % e.message)
                    return self._json(200, {"ok": False, "error": e.message, "fatal": e.fatal,
                                            "retryable": e.retryable})
            if path == "/api/site/scan":
                payload = self._read_json(MAX_BODY_BYTES)
                try:
                    return self._json(200, site_scan(load_config(), payload))
                except SearchError as e:
                    return self._json(200, {"ok": False, "error": e.message, "fatal": False, "retryable": False})
            if path == "/api/contact/test":
                self._read_json(MAX_BODY_BYTES)
                return self._json(200, test_contact_provider(load_config()))
            if path == "/api/config":
                payload = self._read_json(MAX_BODY_BYTES)
                cfg = load_config()
                if payload.get("provider") is not None:
                    if payload["provider"] not in PROVIDERS:
                        return self._json(400, {"ok": False, "error": "Unknown provider."})
                    cfg["provider"] = payload["provider"]
                if payload.get("contactProvider") is not None:
                    if payload["contactProvider"] not in CONTACT_PROVIDERS:
                        return self._json(400, {"ok": False, "error": "Unknown email/phone provider."})
                    cfg["contactProvider"] = payload["contactProvider"]
                if payload.get("key") is not None:
                    target = payload.get("keyProvider") or cfg["provider"]
                    if target not in KEYED:
                        return self._json(400, {"ok": False, "error": "That service does not use a key."})
                    key = str(payload["key"]).strip()
                    if len(key) > 256 or re.search(r"\s", key):
                        return self._json(400, {"ok": False, "error": "That does not look like an API key."})
                    cfg["keys"][target] = key
                save_config(cfg)
                return self._json(200, dict(self._config_view(cfg), ok=True))
            if path == "/api/test":
                self._read_json(MAX_BODY_BYTES)
                return self._json(200, test_provider(load_config()))
            if path == "/api/state":
                payload = self._read_json(MAX_STATE_BYTES)
                ensure_data_dir()
                write_atomic(os.path.join(DATA_DIR, "session.json"), json.dumps(payload))
                return self._json(200, {"ok": True})
            if path == "/api/cache/clear":
                self._read_json(MAX_BODY_BYTES)
                CACHE.clear()
                return self._json(200, {"ok": True})
        except SearchError as e:
            return self._json(400, {"ok": False, "error": e.message})
        except OSError as e:
            log("storage error: %s" % e)
            return self._json(500, {"ok": False, "error": "Could not write to the data folder: %s" % e})
        return self._json(404, {"ok": False, "error": "Not found"})

    def _config_view(self, cfg):
        keys = {}
        for p in KEYED:
            k = api_key(cfg, p)
            keys[p] = {"set": bool(k), "masked": mask(k), "fromEnv": bool(os.environ.get(ENV_KEYS[p], "").strip())}
        return {"provider": cfg["provider"], "contactProvider": cfg["contactProvider"], "keys": keys}

    def _api_get(self, path):
        if path == "/api/health":
            cfg = load_config()
            with _lock:
                stats = dict(_stats)
            return self._json(200, dict(self._config_view(cfg), ok=True, version=VERSION, stats=stats))
        if path == "/api/config":
            return self._json(200, dict(self._config_view(load_config()), ok=True))
        if path == "/api/state":
            p = os.path.join(DATA_DIR, "session.json")
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return self._send(200, f.read())
            except OSError:
                return self._json(200, {})
        return self._json(404, {"ok": False, "error": "Not found"})

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        root = os.path.realpath(STATIC_DIR)
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            return self._send(404, "Not found", "text/plain; charset=utf-8")
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, CONTENT_TYPES.get(ext, "application/octet-stream"))


# ------------------------------------------------------------------ startup

def make_server(port, tries=10):
    last = None
    for p in range(port, port + tries):
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), Handler)
        except OSError as e:
            last = e
    raise SystemExit("Could not start: ports %d-%d are all busy (%s). Close the other window or use --port."
                     % (port, port + tries - 1, last))


def main(argv=None):
    global CACHE
    ap = argparse.ArgumentParser(description="LinkedIn Lead Finder local server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("LLF_PORT", "8765")))
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--provider", choices=PROVIDERS, help="switch the saved provider before starting")
    args = ap.parse_args(argv)

    if sys.version_info < (3, 7):
        raise SystemExit("Python 3.7 or newer is required (you have %s)." % sys.version.split()[0])
    if not os.path.isfile(os.path.join(STATIC_DIR, "index.html")):
        raise SystemExit("static/index.html is missing. Extract the whole ZIP, then run this again.")
    ensure_data_dir()
    CACHE = Cache(os.path.join(DATA_DIR, "cache.sqlite3"))
    if args.provider:
        cfg = load_config()
        cfg["provider"] = args.provider
        save_config(cfg)

    httpd = make_server(args.port)
    httpd.daemon_threads = True
    url = "http://127.0.0.1:%d/" % httpd.server_port
    print("")
    print("  LinkedIn Lead Finder %s is running." % VERSION)
    print("  Open this address in Chrome or Edge:  %s" % url)
    print("  Keep this window open while you use the tool. Press Ctrl+C to stop.")
    print("")
    sys.stdout.flush()
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


def _wait_for_enter():
    try:
        input("Press Enter to close this window...")
    except (EOFError, KeyboardInterrupt):
        pass


def run(argv=None):
    """Start the server; on Windows keep the window open if something goes wrong, so the message can be read.
    (START_WINDOWS.bat already pauses, and sets LLF_FROM_BAT.)"""
    pause = os.name == "nt" and not os.environ.get("LLF_FROM_BAT")
    try:
        main(argv)
    except SystemExit as e:
        if e.code not in (None, 0):
            if not isinstance(e.code, int):
                print("")
                print(e.code)
            if pause:
                print("")
                _wait_for_enter()
            sys.exit(e.code if isinstance(e.code, int) else 1)
    except Exception:
        import traceback
        traceback.print_exc()
        if pause:
            print("")
            _wait_for_enter()
        sys.exit(1)


if __name__ == "__main__":
    run()
