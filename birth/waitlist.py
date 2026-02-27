#!/usr/bin/env python3
"""Minimal waitlist signup server. Appends emails to /tmp/waitlist.txt."""

from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote_plus
import datetime, json

WAITLIST_FILE = "/tmp/waitlist.txt"

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode()
        email = ""
        for pair in body.split("&"):
            k, _, v = pair.partition("=")
            if k == "email":
                email = unquote_plus(v).strip()
        if email:
            with open(WAITLIST_FILE, "a") as f:
                f.write(f"{datetime.datetime.now().isoformat()}\t{email}\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"waitlist ok\n")

    def log_message(self, fmt, *args):
        pass  # silence logs

HTTPServer(("127.0.0.1", 9099), Handler).serve_forever()
