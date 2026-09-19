"""Serve docs/ plus the serverless API (src/pricer/cboe.py) on one local port: the same code path the hosted site uses.

    python scripts/dev_serverless.py [port]      # default 8004, then open http://127.0.0.1:8004
Unlike `python -m pricer serve` this has NO Yahoo, NO pandas and NO /api/surface: the browser builds surfaces from /api/chains.
"""
import mimetypes
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from pricer import cboe  # noqa: E402

DOCS = ROOT / "docs"


class H(cboe.BaseHandler):
    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.op = path.split("/")[2]
            return super().do_GET()
        f = (DOCS / (path.lstrip("/") or "index.html")).resolve()
        if DOCS.resolve() not in f.parents or not f.is_file():
            self.send_response(404); self.end_headers(); return
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8004
    print(f"serverless-style API + site on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
