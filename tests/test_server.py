"""Tests for server.py against a fake SerpApi / Serper service.

Run:  python -m unittest discover -s tests -v
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HITS = {}
JOBS = {}
SITE_HITS = []


def _cf(email, key=0x4a):
    return "%02x" % key + "".join("%02x" % (ord(c) ^ key) for c in email)


SITE_PAGES = {
    "/": '<html><body><nav><a href="/contact">Contact us</a> <a href="/team/">Our team</a> <a href="/private">Board</a>'
         ' <a href="https://elsewhere.example/contact">x</a></nav><p>Welcome to Acme Roofing.</p></body></html>',
    "/contact": '<html><body><h1>Contact</h1><a href="mailto:info@acme.test">info@acme.test</a>'
                '<p>Office phone: (512) 555-0100 &nbsp; Fax: (512) 555-0101</p><a href="tel:+15125550100">Call</a>'
                '<p>Billing: <a href="/cdn-cgi/l/email-protection#%s">[email protected]</a></p></body></html>' % _cf("billing@acme.test"),
    "/team": '<html><body><div><h3>John Smith</h3><p>CEO</p><a href="mailto:jsmith@acme.test">Email John</a></div>'
             '<div><h3>Maria Garcia</h3><p>CFO - mgarcia [at] acme [dot] test - direct 512 555 0177</p></div></body></html>',
    "/private": '<html><body>secret.person@acme.test</body></html>',
    "/robots.txt": "User-agent: *\nDisallow: /private\n",
}


class FakeSite(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        SITE_HITS.append(path)
        body = SITE_PAGES.get(path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain" if path.endswith(".txt") else "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class FakeUpstream(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/v2/email-finder":  # Hunter
            if self.headers.get("X-API-KEY") != "good-hunter":
                return self._reply(401, {"errors": [{"id": "authentication_failed", "code": 401,
                                                     "details": "No user found for the API key supplied"}]})
            HITS["hunter"] = HITS.get("hunter", 0) + 1
            if q.get("first_name") == "Broke":
                return self._reply(429, {"errors": [{"id": "usage_exceeded", "code": 429,
                                                     "details": "You have exceeded your monthly usage limit"}]})
            if q.get("first_name") == "Nobody":
                return self._reply(200, {"data": {"first_name": "Nobody", "email": None, "score": None}, "meta": {}})
            dom = q.get("domain") or (q.get("company", "x").lower().replace(" ", "") + ".com")
            return self._reply(200, {"data": {"first_name": q.get("first_name"), "last_name": q.get("last_name"),
                                              "email": "%s.%s@%s" % (q.get("first_name", "").lower(), q.get("last_name", "").lower(), dom),
                                              "score": 94, "position": "CEO", "phone_number": None,
                                              "verification": {"date": "2026-01-01", "status": "valid"}}, "meta": {}})
        if u.path == "/v2/account":
            if self.headers.get("X-API-KEY") != "good-hunter":
                return self._reply(401, {"errors": [{"id": "authentication_failed", "code": 401, "details": "No user found"}]})
            return self._reply(200, {"data": {"requests": {"searches": {"used": 3, "available": 50}}}})
        if u.path == "/resolve":  # DNS over HTTPS
            if q.get("name", "").startswith("nomail"):
                return self._reply(200, {"Status": 0, "Answer": []})
            return self._reply(200, {"Status": 0, "Answer": [{"name": q.get("name"), "type": 15, "data": "10 mx.acme.test."}]})
        if u.path == "/v1/auth/health":  # Apollo
            ok = self.headers.get("x-api-key") == "good-apollo"
            return self._reply(200, {"healthy": True, "is_logged_in": ok})
        if u.path.startswith("/api/v2/contact/enrich/bulk/"):  # FullEnrich results
            if self.headers.get("Authorization") != "Bearer good-fe":
                return self._reply(401, {"message": "Invalid API key"})
            job = u.path.rsplit("/", 1)[1]
            people = JOBS.get(job)
            if people is None:
                return self._reply(404, {"message": "Not found"})
            JOBS["_polls_" + job] = JOBS.get("_polls_" + job, 0) + 1
            if JOBS["_polls_" + job] < 2:
                return self._reply(200, {"id": job, "status": "IN_PROGRESS"})
            data = []
            for i, pp in enumerate(people):
                info = {}
                if pp.get("first_name") != "Nobody":
                    info["most_probable_work_email"] = {"email": "%s@%s" % (pp.get("first_name", "").lower(), pp.get("domain") or "acme.com"),
                                                        "status": "DELIVERABLE"}
                    info["work_emails"] = [info["most_probable_work_email"]]
                    if "contact.phones" in pp.get("enrich_fields", []):
                        info["most_probable_phone"] = {"number": "+1 512 555 01%02d" % i, "region": "US"}
                data.append({"custom": pp.get("custom"), "contact_info": info})
            return self._reply(200, {"id": job, "status": "FINISHED", "data": data})
        if u.path == "/api/v2/account/credits":
            if self.headers.get("Authorization") != "Bearer good-fe":
                return self._reply(401, {"message": "Invalid API key"})
            return self._reply(200, {"balance": 42})
        if u.path == "/account.json":
            if q.get("api_key") != "good-serpapi-key":
                return self._reply(401, {"error": "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"})
            return self._reply(200, {"plan_name": "Developer", "total_searches_left": 95, "plan_searches_left": 95})
        if u.path != "/search.json":
            return self._reply(404, {"error": "not found"})
        query = q.get("q", "")
        HITS[query] = HITS.get(query, 0) + 1
        if q.get("api_key") != "good-serpapi-key":
            return self._reply(401, {"error": "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"})
        if "outofcredits" in query:
            return self._reply(429, {"error": "Your account has run out of searches."})
        if "flaky" in query and HITS[query] == 1:
            return self._reply(503, {"error": "Service temporarily unavailable"})
        if "broken" in query:
            return self._reply(500, {"error": "Internal error"})
        if "nothing" in query:
            return self._reply(200, {"search_metadata": {"status": "Success"},
                                     "error": "Google hasn't returned any results for this query."})
        start = int(q.get("start", "0"))
        if "kgtest" in query:
            return self._reply(200, {"organic_results": [], "knowledge_graph": {"title": "CSX", "website": "https://www.csx.com/"}})
        return self._reply(200, {
            "search_metadata": {"status": "Success"},
            "organic_results": [
                {"position": 1, "title": "Sumit Kumar - INOCYX | LinkedIn", "link": "https://in.linkedin.com/in/sumit-k",
                 "snippet": "Head of Operations at INOCYX · Location: Chennai",
                 "rich_snippet": {"top": {"extensions": ["Chennai, Tamil Nadu, India", "Head of Operations", "INOCYX"]}}},
                {"position": 2, "title": "Page %d" % (start // 10 + 1), "link": "https://www.linkedin.com/posts/x"},
            ],
            "serpapi_pagination": {"next": "https://serpapi.com/next"} if start < 20 else {},
            "echo": {"gl": q.get("gl"), "hl": q.get("hl"), "start": q.get("start")},
        })

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/v1/people/match":  # Apollo
            if self.headers.get("x-api-key") != "good-apollo":
                return self._reply(401, {"error": "Invalid access credentials."})
            first = body.get("first_name")
            if first == "Broke":
                return self._reply(422, {"error": "Insufficient credits. Please upgrade your plan."})
            if first == "Nobody":
                return self._reply(200, {"person": None})
            email = "email_not_unlocked@domain.com" if first == "Locked" else "%s@%s" % (first.lower(), body.get("domain") or "acme.com")
            return self._reply(200, {"person": {"first_name": first, "email": email, "email_status": "verified",
                                                "title": "VP Sales", "phone_numbers": [{"sanitized_number": "+15125550100"}]}})
        if self.path == "/api/v2/contact/enrich/bulk":  # FullEnrich start
            if self.headers.get("Authorization") != "Bearer good-fe":
                return self._reply(401, {"message": "Invalid API key"})
            if any(p.get("first_name") == "Broke" for p in body.get("data", [])):
                return self._reply(403, {"message": "Not enough credits"})
            job = "job%d" % (len([k for k in JOBS if not k.startswith("_")]) + 1)
            JOBS[job] = body.get("data", [])
            JOBS["_name_" + job] = body.get("name")
            return self._reply(200, {"enrichment_id": job})
        if self.path != "/search":
            return self._reply(404, {"message": "not found"})
        if self.headers.get("X-API-KEY") != "good-serper-key":
            return self._reply(403, {"message": "Unauthorized.", "statusCode": 403})
        HITS["serper:" + body.get("q", "")] = HITS.get("serper:" + body.get("q", ""), 0) + 1
        return self._reply(200, {"organic": [
            {"title": "Jane Doe - Acme | LinkedIn", "link": "https://www.linkedin.com/in/jane-doe", "snippet": "Location: Austin",
             "attributes": {"Location": "Austin, Texas", "Title": "CEO"}, "position": 1},
        ], "searchParameters": {"page": body.get("page")}})


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        cls.site = ThreadingHTTPServer(("127.0.0.1", 0), FakeSite)
        threading.Thread(target=cls.site.serve_forever, daemon=True).start()
        fake_url = "http://127.0.0.1:%d" % cls.fake.server_port
        cls.data = tempfile.mkdtemp(prefix="llf-test-")
        cls.port = free_port()
        env = dict(os.environ, LLF_DATA_DIR=cls.data, LLF_SERPAPI_URL=fake_url, LLF_SERPER_URL=fake_url,
                   LLF_HUNTER_URL=fake_url, LLF_APOLLO_URL=fake_url, LLF_FULLENRICH_URL=fake_url,
                   LLF_DOH_URL=fake_url + "/resolve", LLF_ALLOW_PRIVATE_FETCH="1",
                   SERPAPI_KEY="", SERPER_API_KEY="", HUNTER_API_KEY="", APOLLO_API_KEY="", FULLENRICH_API_KEY="",
                   PYTHONIOENCODING="utf-8")
        cls.proc = subprocess.Popen([sys.executable, os.path.join(APP_DIR, "server.py"), "--port", str(cls.port), "--no-browser"],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        cls.base = "http://127.0.0.1:%d" % cls.port
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + "/api/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not start: " + cls.proc.stdout.read().decode())

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.proc.stdout.close()
        cls.fake.shutdown()
        cls.fake.server_close()
        cls.site.shutdown()
        cls.site.server_close()
        shutil.rmtree(cls.data, ignore_errors=True)

    # helpers
    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            r = urllib.request.urlopen(req, timeout=20)
            return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def post(self, path, obj, headers=None, raw=None):
        h = {"Content-Type": "application/json", "X-LLF": "1"}
        h.update(headers or {})
        data = raw if raw is not None else json.dumps(obj).encode()
        req = urllib.request.Request(self.base + path, data=data, headers=h, method="POST")
        try:
            r = urllib.request.urlopen(req, timeout=30)
            return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def use(self, provider, key=None):
        self.post("/api/config", {"provider": provider})
        if key is not None:
            s, r = self.post("/api/config", {"key": key, "keyProvider": provider})
            self.assertEqual(s, 200, r)

    # tests
    def test_01_static_files(self):
        s, body, h = self.get("/")
        self.assertEqual(s, 200)
        self.assertIn(b"LinkedIn Lead Finder", body)
        self.assertEqual(h["Cache-Control"], "no-store")
        for p in ("/core.js", "/app.js", "/styles.css"):
            self.assertEqual(self.get(p)[0], 200, p)
        for bad in ("/../server.py", "/%2e%2e/server.py", "/..%2fserver.py", "/static/../server.py", "/nope.js"):
            self.assertEqual(self.get(bad)[0], 404, bad)

    def test_02_security_checks(self):
        self.assertEqual(self.post("/api/search", {"query": "x"}, headers={"X-LLF": ""})[0], 403)
        self.assertEqual(self.post("/api/search", {"query": "x"}, headers={"Content-Type": "text/plain"})[0], 403)
        self.assertEqual(self.post("/api/search", {"query": "x"}, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.post("/api/search", {"query": "x"}, headers={"Origin": "http://127.0.0.1:1"})[0], 403)
        self.assertEqual(self.get("/", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.post("/api/search", None, raw=b"not json")[0], 400)
        self.assertEqual(self.post("/api/nope", {})[0], 404)

    def test_02b_rejected_post_does_not_poison_keepalive(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/api/search", body=b'{"query": "x"}', headers={"Content-Type": "application/json"})
        r = conn.getresponse()
        r.read()
        self.assertEqual(r.status, 403)
        conn.request("GET", "/api/health")
        r = conn.getresponse()
        self.assertEqual(r.status, 200)
        self.assertTrue(json.loads(r.read())["ok"])
        conn.close()

    def test_03_missing_key_is_fatal(self):
        self.use("serpapi", "")
        s, r = self.post("/api/search", {"query": "site:linkedin.com/in/ \"A\""})
        self.assertFalse(r["ok"])
        self.assertTrue(r["fatal"])
        self.assertIn("No API key", r["error"])

    def test_04_serpapi_flow(self):
        self.use("serpapi", "bad-key")
        s, r = self.post("/api/test", {})
        self.assertFalse(r["ok"])
        self.assertIn("Invalid API key", r["message"])
        s, r = self.post("/api/search", {"query": "q-badkey"})
        self.assertFalse(r["ok"])
        self.assertTrue(r["fatal"])

        self.use("serpapi", "good-serpapi-key")
        s, cfg = self.get("/api/config")[:2]
        cfg = json.loads(cfg)
        self.assertEqual(cfg["keys"]["serpapi"]["masked"], "good...-key")
        self.assertNotIn("good-serpapi-key", json.dumps(cfg))
        s, r = self.post("/api/test", {})
        self.assertTrue(r["ok"], r)
        self.assertIn("95", r["message"])

        q = 'site:linkedin.com/in/ "Sumit Kumar" "INOCYX"'
        s, r = self.post("/api/search", {"query": q, "page": 1, "gl": "IN", "hl": "en", "cacheDays": 30})
        self.assertTrue(r["ok"], r)
        self.assertFalse(r["cached"])
        self.assertTrue(r["hasMore"])
        self.assertEqual(r["results"][0]["link"], "https://in.linkedin.com/in/sumit-k")
        self.assertEqual(r["results"][0]["extras"], ["Chennai, Tamil Nadu, India", "Head of Operations", "INOCYX"])
        s, r2 = self.post("/api/search", {"query": q, "page": 1, "gl": "in", "hl": "en", "cacheDays": 30})
        self.assertTrue(r2["cached"])
        self.assertEqual(HITS[q], 1, "second identical search must come from the cache")
        s, r3 = self.post("/api/search", {"query": q, "page": 3, "cacheDays": 30})
        self.assertFalse(r3["hasMore"])
        self.assertEqual(r3["results"][1]["title"], "Page 3")
        s, r4 = self.post("/api/search", {"query": q, "page": 1, "gl": "in", "hl": "en", "cacheDays": 0})
        self.assertFalse(r4["cached"], "cacheDays 0 must skip the cache")

    def test_05_serpapi_errors(self):
        self.use("serpapi", "good-serpapi-key")
        s, r = self.post("/api/search", {"query": "kgtest csx", "mode": "web"})
        self.assertEqual(r["kg"], {"title": "CSX", "website": "https://www.csx.com/", "phone": ""})
        s, r = self.post("/api/search", {"query": "kgtest csx", "mode": "web"})
        self.assertTrue(r["cached"])
        self.assertEqual(r["kg"]["website"], "https://www.csx.com/", "the website is kept in the cache too")
        s, r = self.post("/api/search", {"query": "nothing here"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["results"], [])
        s, r = self.post("/api/search", {"query": "outofcredits"})
        self.assertFalse(r["ok"])
        self.assertTrue(r["fatal"])
        self.assertIn("run out of searches", r["error"])
        t = time.time()
        s, r = self.post("/api/search", {"query": "flaky one"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(HITS["flaky one"], 2)
        self.assertGreater(time.time() - t, 1.0)
        s, r = self.post("/api/search", {"query": "broken"})
        self.assertFalse(r["ok"])
        self.assertFalse(r["fatal"])
        self.assertTrue(r["retryable"])
        self.assertEqual(HITS["broken"], 3, "retried twice before giving up")
        for bad in ({"query": ""}, {"query": "x" * 3000}, {"query": "x", "page": "abc"}):
            s, r = self.post("/api/search", bad)
            self.assertFalse(r["ok"], bad)

    def test_06_serper_flow(self):
        self.use("serper", "wrong")
        s, r = self.post("/api/search", {"query": "jane"})
        self.assertFalse(r["ok"])
        self.assertTrue(r["fatal"])
        self.use("serper", "good-serper-key")
        s, r = self.post("/api/search", {"query": "jane", "page": 2})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["results"][0]["link"], "https://www.linkedin.com/in/jane-doe")
        self.assertEqual(r["results"][0]["extras"], ["Austin, Texas", "CEO"])
        s, r = self.post("/api/test", {})
        self.assertTrue(r["ok"], r)

    def test_07_mock_provider(self):
        self.use("mock")
        s, r = self.post("/api/search", {"query": 'site:linkedin.com/in/ "Head of Operations" "Chennai"', "mode": "xray", "page": 2})
        self.assertTrue(r["ok"])
        self.assertTrue(r["hasMore"])
        profiles = [x for x in r["results"] if "/in/" in x["link"]]
        self.assertEqual(len(profiles), 10)
        self.assertTrue(all("/in/mock-" in x["link"] for x in profiles))
        s, r = self.post("/api/search", {"query": 'site:linkedin.com/company/ "roofing" "Dallas"', "mode": "company",
                                         "meta": {"keyword": "roofing", "location": "Dallas"}})
        self.assertTrue(r["ok"])
        companies = [x for x in r["results"] if "/company/" in x["link"]]
        self.assertEqual(len(companies), 10)
        self.assertTrue(all("Dallas" in x["snippet"] for x in companies))
        s, r = self.post("/api/search", {"query": "Congruex", "mode": "web", "meta": {"company": "Congruex"}})
        self.assertTrue(r["ok"])
        self.assertIn("facebook.com", r["results"][0]["link"])
        s, r = self.post("/api/search", {"query": "x", "mode": "xray", "meta": {"title": "CFO", "company": "Acme"}})
        self.assertIn("CFO - Acme", r["results"][0]["title"])
        s, r = self.post("/api/search", {"query": 'site:linkedin.com/in/ "Sumit Kumar" "INOCYX"', "mode": "find"})
        self.assertTrue(r["ok"])
        s, r = self.post("/api/test", {})
        self.assertTrue(r["ok"])
        self.assertEqual(self.post("/api/config", {"provider": "google"})[0], 400)
        self.assertEqual(self.post("/api/config", {"key": "has space"})[0], 400)

    def test_08_state_roundtrip(self):
        state = {"version": 2, "rows": [{"name": "Dr. Kerlin Sara Wilson", "company": "nice Neotech ✓"}], "settings": {"maxLeads": 3000}}
        s, r = self.post("/api/state", state)
        self.assertTrue(r["ok"])
        s, body, _ = self.get("/api/state")
        self.assertEqual(json.loads(body), state)
        s, r = self.post("/api/cache/clear", {})
        self.assertTrue(r["ok"])
        self.assertTrue(os.path.isfile(os.path.join(self.data, "config.json")))
        self.assertFalse([f for f in os.listdir(self.data) if f.endswith(".tmp")])

    # ---- email & phone finders
    def contact(self, provider, key=None):
        self.post("/api/config", {"contactProvider": provider})
        if key is not None:
            s, r = self.post("/api/config", {"key": key, "keyProvider": provider})
            self.assertEqual(s, 200, r)

    def person(self, first, last="Doe", **kw):
        p = {"id": "7", "first": first, "last": last, "full": first + " " + last, "company": "Acme Roofing",
             "domain": "https://www.acme.com/", "linkedin": "https://www.linkedin.com/in/x"}
        p.update(kw)
        return p

    def test_09_hunter(self):
        self.contact("hunter", "")
        s, r = self.post("/api/contact", {"person": self.person("Jane"), "want": {"email": True}})
        self.assertFalse(r["ok"]); self.assertTrue(r["fatal"]); self.assertIn("No API key", r["error"])
        self.contact("hunter", "wrong")
        s, r = self.post("/api/contact/test", {})
        self.assertFalse(r["ok"]); self.assertIn("No user found", r["message"])
        s, r = self.post("/api/contact", {"person": self.person("Jane"), "want": {"email": True}})
        self.assertFalse(r["ok"]); self.assertTrue(r["fatal"])
        self.contact("hunter", "good-hunter")
        s, r = self.post("/api/contact/test", {})
        self.assertTrue(r["ok"]); self.assertIn("3 of 50", r["message"])
        s, r = self.post("/api/contact", {"person": self.person("Jane"), "want": {"email": True, "phone": True}})
        self.assertTrue(r["ok"], r)
        self.assertEqual([r["email"], r["emailStatus"], r["phone"]], ["jane.doe@acme.com", "valid", ""])
        s, r = self.post("/api/contact", {"person": self.person("Bob", domain=""), "want": {"email": True}})
        self.assertEqual(r["email"], "bob.doe@acmeroofing.com")  # company name used when there is no website
        s, r = self.post("/api/contact", {"person": self.person("Nobody"), "want": {"email": True}})
        self.assertTrue(r["ok"]); self.assertEqual(r["email"], "")
        s, r = self.post("/api/contact", {"person": self.person("Broke"), "want": {"email": True}})
        self.assertFalse(r["ok"]); self.assertTrue(r["fatal"], r)
        s, r = self.post("/api/contact", {"person": {"id": "1"}, "want": {"email": True}})
        self.assertFalse(r["ok"])

    def test_10_apollo(self):
        self.contact("apollo", "wrong")
        s, r = self.post("/api/contact/test", {})
        self.assertFalse(r["ok"])
        s, r = self.post("/api/contact", {"person": self.person("Jane"), "want": {"email": True}})
        self.assertFalse(r["ok"]); self.assertTrue(r["fatal"])
        self.contact("apollo", "good-apollo")
        s, r = self.post("/api/contact/test", {})
        self.assertTrue(r["ok"], r)
        s, r = self.post("/api/contact", {"person": self.person("Jane"), "want": {"email": True, "phone": True}})
        self.assertEqual([r["email"], r["emailStatus"], r["phone"]], ["jane@acme.com", "verified", "+15125550100"])
        s, r = self.post("/api/contact", {"person": self.person("Locked"), "want": {"email": True}})
        self.assertEqual(r["email"], "", "Apollo's locked placeholder is not an email")
        s, r = self.post("/api/contact", {"person": self.person("Nobody"), "want": {"email": True}})
        self.assertTrue(r["ok"]); self.assertEqual(r["email"], "")
        s, r = self.post("/api/contact", {"person": self.person("Broke"), "want": {"email": True}})
        self.assertFalse(r["ok"]); self.assertTrue(r["fatal"], r)

    def test_11_fullenrich(self):
        self.contact("fullenrich", "wrong")
        s, r = self.post("/api/contact/test", {})
        self.assertFalse(r["ok"])
        s, r = self.post("/api/contact/start", {"people": [self.person("Jane")], "want": {"email": True}})
        self.assertFalse(r["ok"]); self.assertTrue(r["fatal"])
        self.contact("fullenrich", "good-fe")
        s, r = self.post("/api/contact/test", {})
        self.assertTrue(r["ok"]); self.assertIn("42", r["message"])
        people = [self.person("Jane", id="11"), self.person("Nobody", id="12"), self.person("Raj", id="13", domain="")]
        s, r = self.post("/api/contact/start", {"people": people, "want": {"email": True, "phone": True}})
        self.assertTrue(r["ok"], r)
        job = r["job"]
        sent = JOBS[job]
        self.assertEqual(sent[0]["first_name"], "Jane")
        self.assertEqual(sent[0]["domain"], "acme.com")
        self.assertEqual(sent[0]["linkedin_url"], "https://www.linkedin.com/in/x")
        self.assertEqual(sent[0]["enrich_fields"], ["contact.work_emails", "contact.phones"])
        self.assertEqual(sent[0]["custom"], {"lpf_id": "11"})
        self.assertNotIn("domain", sent[2])
        s, r = self.post("/api/contact/poll", {"job": job})
        self.assertEqual([r["ok"], r["done"]], [True, False])
        s, r = self.post("/api/contact/poll", {"job": job})
        self.assertTrue(r["done"])
        got = {x["id"]: (x["email"], x["emailStatus"], x["phone"]) for x in r["results"]}
        self.assertEqual(got["11"], ("jane@acme.com", "DELIVERABLE", "+1 512 555 0100"))
        self.assertEqual(got["12"], ("", "", ""))
        self.assertEqual(got["13"][0], "raj@acme.com")
        s, r = self.post("/api/contact/poll", {"job": "../etc"})
        self.assertFalse(r["ok"])
        s, r = self.post("/api/contact/start", {"people": [self.person("Broke")], "want": {"email": True}})
        self.assertFalse(r["ok"]); self.assertTrue(r["fatal"], r)
        s, r = self.post("/api/contact/start", {"people": [], "want": {"email": True}})
        self.assertFalse(r["ok"])

    def test_12_mock_contacts(self):
        self.contact("mock")
        s, r = self.post("/api/contact/test", {})
        self.assertTrue(r["ok"])
        found = 0
        for i in range(20):
            s, r = self.post("/api/contact", {"person": self.person("P%d" % i), "want": {"email": True, "phone": True}})
            self.assertTrue(r["ok"])
            found += bool(r["email"])
        self.assertTrue(5 <= found <= 19, found)
        s, cfg = self.get("/api/config")[:2]
        cfg = json.loads(cfg)
        self.assertEqual(cfg["contactProvider"], "mock")
        self.assertTrue(cfg["keys"]["hunter"]["set"])
        self.assertNotIn("good-hunter", json.dumps(cfg))

    # ---- free finder: reading a company website
    def test_13_site_scan(self):
        self.use("serpapi", "good-serpapi-key")  # a real (non-mock) search provider, so the real reader runs
        domain = "127.0.0.1:%d" % self.site.server_port
        del SITE_HITS[:]
        s, r = self.post("/api/site/scan", {"domain": "http://" + domain + "/", "maxPages": 6, "cacheDays": 30})
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["reachable"])
        self.assertFalse(r["cached"])
        emails = {e["email"]: e for e in r["emails"]}
        self.assertEqual(sorted(emails), ["billing@acme.test", "info@acme.test", "jsmith@acme.test", "mgarcia@acme.test"])
        self.assertIn("John Smith", emails["jsmith@acme.test"]["context"], "the name next to a link-hidden email is kept")
        self.assertTrue(emails["info@acme.test"]["page"].endswith("/contact"))
        numbers = [p["number"] for p in r["phones"]]
        self.assertIn("+15125550100", numbers)
        self.assertFalse(any("0101" in n for n in numbers), "fax numbers are ignored")
        self.assertTrue(any("555 0177" in n for n in numbers))
        self.assertNotIn("/private", SITE_HITS, "pages the site's robots.txt forbids are not read")
        self.assertEqual(r["robotsBlocked"], 1, "the 'Board' page was skipped because robots.txt forbids it")
        self.assertTrue(r["mx"])
        self.assertLessEqual(len(r["pages"]), 6)
        s, r2 = self.post("/api/site/scan", {"domain": domain, "maxPages": 6, "cacheDays": 30})
        self.assertTrue(r2["cached"], "a website is read once, then remembered")
        for bad in ("not a domain", "javascript:alert(1)", ""):
            s, r = self.post("/api/site/scan", {"domain": bad})
            self.assertFalse(r["ok"], bad)
        self.use("mock")
        s, r = self.post("/api/site/scan", {"domain": "acme-roofing.com", "names": ["John Smith", "Maria Garcia"]})
        self.assertTrue(r["ok"])

    def test_14_never_reads_local_addresses(self):
        sys.path.insert(0, APP_DIR)
        import server as srv
        self.assertFalse(srv.ALLOW_PRIVATE_FETCH)
        for host in ("127.0.0.1", "localhost", "10.1.2.3", "192.168.1.1", "169.254.169.254", "::1"):
            self.assertFalse(srv.host_is_public(host), host)
        self.assertIsNone(srv.fetch_page("http://127.0.0.1:%d/" % self.site.server_port, time.time() + 5))
        self.assertIsNone(srv.fetch_page("file:///etc/passwd", time.time() + 5))
        self.assertEqual(srv.decode_cfemail(_cf("a.b@c.de")), "a.b@c.de")


if __name__ == "__main__":
    unittest.main()
