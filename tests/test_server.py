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
        fake_url = "http://127.0.0.1:%d" % cls.fake.server_port
        cls.data = tempfile.mkdtemp(prefix="llf-test-")
        cls.port = free_port()
        env = dict(os.environ, LLF_DATA_DIR=cls.data, LLF_SERPAPI_URL=fake_url, LLF_SERPER_URL=fake_url,
                   SERPAPI_KEY="", SERPER_API_KEY="", PYTHONIOENCODING="utf-8")
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
        s, r = self.post("/api/search", {"query": 'x', "mode": "xray", "meta": {"title": "CFO", "company": "Acme"}})
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


if __name__ == "__main__":
    unittest.main()
