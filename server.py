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
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2.0.0"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
DATA_DIR = os.environ.get("LLF_DATA_DIR") or os.path.join(APP_DIR, "data")
SERPAPI_BASE = os.environ.get("LLF_SERPAPI_URL", "https://serpapi.com").rstrip("/")
SERPER_BASE = os.environ.get("LLF_SERPER_URL", "https://google.serper.dev").rstrip("/")
PROVIDERS = ("serpapi", "serper", "mock")
ENV_KEYS = {"serpapi": "SERPAPI_KEY", "serper": "SERPER_API_KEY"}
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
    cfg = {"provider": "serpapi", "keys": {"serpapi": "", "serper": ""}}
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            saved = json.load(f)
        if saved.get("provider") in PROVIDERS:
            cfg["provider"] = saved["provider"]
        for k in ("serpapi", "serper"):
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
        msg = parsed.get("error") or parsed.get("message") or ""
        if isinstance(msg, dict):
            msg = msg.get("message") or json.dumps(msg)
    msg = str(msg or text[:200] or ("HTTP %d" % status)).strip()
    name = {"serpapi": "SerpApi", "serper": "Serper"}[provider]
    fatal = status in (401, 402, 403) or bool(FATAL_WORDS.search(msg))
    retryable = not fatal and (status == 429 or status >= 500 or status == 0)
    if fatal and status in (401, 403) and "key" not in msg.lower():
        msg += " - check the API key in Settings."
    return SearchError("%s: %s" % (name, msg), fatal=fatal, retryable=retryable, status=status)


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
            return [], False
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
    return results, bool(pagination.get("next"))


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
    return results, len(results) >= 8


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


def search_mock(query, page, mode):
    time.sleep(0.12)
    phrases = re.findall(r'"([^"]+)"', query)
    noise = [
        {"title": "Posts | LinkedIn", "link": "https://www.linkedin.com/posts/mock-post-%d" % (_h(query) % 9999),
         "snippet": "A LinkedIn post (should be ignored by the matcher).", "extras": []},
        {"title": "Mock Company | LinkedIn", "link": "https://www.linkedin.com/company/mock-company",
         "snippet": "Company page (should be ignored).", "extras": []},
    ]
    if mode == "xray":
        if page > 5:
            return [], False
        title = phrases[0] if phrases else "Professional"
        place = phrases[1] if len(phrases) > 1 else "Chennai, Tamil Nadu, India"
        out = []
        for i in range(10):
            h = _h("%s|%d|%d" % (query, page, i))
            name = "%s %s" % (MOCK_FIRST[h % len(MOCK_FIRST)], MOCK_LAST[(h // 7) % len(MOCK_LAST)])
            company = "Mock %s Pvt Ltd" % ["Systems", "Labs", "Foods", "Logistics", "Health"][h % 5]
            out.append({
                "title": "%s - %s - %s | LinkedIn" % (name, title, company),
                "link": "https://in.linkedin.com/in/mock-%s-%x" % (_slug(name), h % 0xFFFFF),
                "snippet": "%s at %s · Experience: %s · Location: %s · 500+ connections on LinkedIn." % (
                    title, company, company, place),
                "extras": [place, title, company],
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
    mode = "xray" if payload.get("mode") == "xray" else "find"

    if provider == "mock":
        results, has_more = search_mock(query, page, mode)
        return {"ok": True, "results": results, "hasMore": has_more, "cached": False, "provider": "mock"}

    key = api_key(cfg, provider)
    if not key:
        raise SearchError("No API key saved for %s. Open Settings, paste your key and click Save."
                          % ("SerpApi" if provider == "serpapi" else "Serper"), fatal=True)
    ckey = Cache.key(provider, query, page, gl, hl)
    hit = CACHE.get(ckey, cache_days)
    if hit is not None:
        with _lock:
            _stats["cache_hits"] += 1
        return {"ok": True, "results": hit["results"], "hasMore": hit["hasMore"], "cached": True, "provider": provider}

    fn = search_serpapi if provider == "serpapi" else search_serper
    attempt = 0
    while True:
        try:
            results, has_more = fn(key, query, page, gl, hl)
            break
        except SearchError as e:
            if e.retryable and attempt < len(RETRY_DELAYS):
                time.sleep(RETRY_DELAYS[attempt] * (1 + random.random() * 0.3))
                attempt += 1
                continue
            raise
    with _lock:
        _stats["api_calls"] += 1
    CACHE.put(ckey, {"results": results, "hasMore": has_more})
    return {"ok": True, "results": results, "hasMore": has_more, "cached": False, "provider": provider}


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
        results, _ = search_serper(key, 'site:linkedin.com/in/ "software engineer"', 1, "", "")
        with _lock:
            _stats["api_calls"] += 1
        return {"ok": True, "message": "Serper key works (this test used 1 search, %d results)." % len(results)}
    except SearchError as e:
        return {"ok": False, "message": e.message}


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
            if path == "/api/config":
                payload = self._read_json(MAX_BODY_BYTES)
                cfg = load_config()
                if payload.get("provider") is not None:
                    if payload["provider"] not in PROVIDERS:
                        return self._json(400, {"ok": False, "error": "Unknown provider."})
                    cfg["provider"] = payload["provider"]
                if payload.get("key") is not None:
                    target = payload.get("keyProvider") or cfg["provider"]
                    if target not in ("serpapi", "serper"):
                        return self._json(400, {"ok": False, "error": "Keys are only used by SerpApi and Serper."})
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
        for p in ("serpapi", "serper"):
            k = api_key(cfg, p)
            keys[p] = {"set": bool(k), "masked": mask(k), "fromEnv": bool(os.environ.get(ENV_KEYS[p], "").strip())}
        return {"provider": cfg["provider"], "keys": keys}

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
