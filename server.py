"""Southern Sharks Ladder Manager: web server.

Run:  python server.py            then open the address it prints.
Phones and tablets on the same Wi-Fi or hotspot use the "On this network" address.
The organiser PIN is in data/config.json (created on first run).
"""
import json
import mimetypes
import os
import secrets
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ladder.store import ActionError, Store

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "docs")
DATA = os.environ.get("LADDER_DATA", os.path.join(HERE, "data"))


def load_config():
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, "config.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    config = dict(pin="%04d" % secrets.randbelow(10000), port=8082)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    return config


def lan_addresses(port):
    found = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return ["http://%s:%d" % (ip, port) for ip in found if not ip.startswith("127.")]


CONFIG = load_config()
STORE = Store(DATA)
PORT = int(os.environ.get("PORT", CONFIG.get("port", 8082)))
OPEN = bool(CONFIG.get("open", True))   # organiser tools without the PIN; set "open": false in data/config.json to require it
URLS = lan_addresses(PORT)


class Handler(BaseHTTPRequestHandler):
    server_version = "LadderLeague/0.1"

    def log_message(self, fmt, *args):
        if "/api/state" not in str(args[0] if args else ""):      # str: for a refused request the first value is a status code, not text
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _state(self):
        return dict(version=STORE.state["version"], state=STORE.state, urls=URLS)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/state":
            have = parse_qs(url.query).get("v", [""])[0]
            with STORE.lock:
                if have == str(STORE.state["version"]):
                    return self._send(204)
                return self._json(200, self._state())
        if url.path == "/config.js":
            # the site's own config (the club's front page), but never the hosted site's database: this server keeps the data
            try:
                with open(os.path.join(STATIC, "config.js"), encoding="utf-8") as f:
                    body = f.read()
            except OSError:
                body = ""
            body += "\nwindow.LADDER_CONFIG = Object.assign({}, window.LADDER_CONFIG, { firebase: null, openOrganiser: %s });\n" % ("true" if OPEN else "false")
            return self._send(200, body.encode("utf-8"), "text/javascript; charset=utf-8")
        rel = "index.html" if url.path in ("/", "") else url.path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_POST(self):
        if urlparse(self.path).path != "/api/action":
            return self._send(404, b"Not found", "text/plain")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 200000:
                return self._json(413, dict(ok=False, code="large", message="Request too large."))
            body = json.loads(self.rfile.read(length) or b"{}")
            kind, args = str(body.get("type", "")), body.get("args") or {}
            org = OPEN or secrets.compare_digest(str(body.get("pin", "")), str(CONFIG["pin"]))
        except (ValueError, TypeError):
            return self._json(400, dict(ok=False, code="bad", message="Bad request."))
        if kind == "auth.check":
            return self._json(200, dict(ok=org, code=None if org else "pin", message=None if org else "That PIN is not right."))
        try:
            result = STORE.apply(kind, args, org)
        except ActionError as e:
            return self._json(200, dict(ok=False, code=e.code, message=e.message, **e.extra))
        except Exception as e:  # keep the server up; report the failure to the client
            sys.stderr.write("action %s failed: %r\n" % (kind, e))
            return self._json(500, dict(ok=False, code="server", message="Something went wrong on the server."))
        with STORE.lock:
            self._json(200, dict(ok=True, result=result, **self._state()))


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Southern Sharks Ladder Manager")
    print("  On this computer:  http://localhost:%d" % PORT)
    for u in URLS:
        print("  On this network:   %s" % u)
    print("  Organiser access:  %s" % ("open, no PIN" if OPEN else "PIN, see " + os.path.join(DATA, "config.json")))
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
