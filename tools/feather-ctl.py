#!/usr/bin/env python3
"""Feather admin sidecar — HTTP API on :4860 for build management.
Standard library only. Managed by supervisord.
"""
import json
import os
import shutil
import subprocess
import time
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

BUILDS_DIR = Path("/usr/local/bin/feather-builds")
ACTIVE_FILE = BUILDS_DIR / "active"
FEATHER_BIN = Path("/usr/local/bin/feather")
HEALTH_URL = "http://localhost:4850/health"
PORT = 4860


def list_builds():
    """Return sorted list of build dicts (newest first)."""
    if not BUILDS_DIR.exists():
        return []
    active = ACTIVE_FILE.read_text().strip() if ACTIVE_FILE.exists() else ""
    builds = []
    for p in sorted(BUILDS_DIR.glob("*.bin"), key=lambda f: f.stem, reverse=True):
        st = p.stat()
        builds.append({
            "version": p.stem,
            "size": st.st_size,
            "timestamp": int(st.st_mtime),
            "active": p.stem == active,
        })
    return builds


def get_health():
    """Fetch Feather /health, return dict or None."""
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=3) as r:
            return json.loads(r.read())
    except Exception:
        return None


def promote_version(version):
    """Copy build to /usr/local/bin/feather, update active file, restart."""
    src = BUILDS_DIR / f"{version}.bin"
    if not src.exists():
        return False, f"Build {version} not found"
    shutil.copy2(str(src), str(FEATHER_BIN))
    os.chmod(str(FEATHER_BIN), 0o755)
    ACTIVE_FILE.write_text(version)
    subprocess.run(["sudo", "supervisorctl", "restart", "feather"],
                   capture_output=True, timeout=10)
    # Poll health for up to 15 seconds
    for _ in range(15):
        time.sleep(1)
        if get_health():
            return True, "OK"
    return True, "Restarted but health check not yet passing"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default logging

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/admin/api/builds":
            self._json(200, {"builds": list_builds()})

        elif self.path == "/admin/api/status":
            health = get_health()
            active = ACTIVE_FILE.read_text().strip() if ACTIVE_FILE.exists() else "unknown"
            builds = list_builds()
            self._json(200, {
                "active_version": active,
                "healthy": health is not None,
                "uptime_secs": health.get("uptime_secs", 0) if health else 0,
                "build_count": len(builds),
            })

        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/admin/api/promote":
            body = self._read_body()
            version = body.get("version", "")
            if not version:
                self._json(400, {"error": "version required"})
                return
            ok, msg = promote_version(version)
            self._json(200 if ok else 404, {"ok": ok, "message": msg})

        elif self.path == "/admin/api/restart":
            subprocess.run(["sudo", "supervisorctl", "restart", "feather"],
                           capture_output=True, timeout=10)
            time.sleep(2)
            health = get_health()
            self._json(200, {"ok": True, "healthy": health is not None})

        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        # /admin/api/builds/{version}
        prefix = "/admin/api/builds/"
        if self.path.startswith(prefix):
            version = self.path[len(prefix):].strip("/")
            if not version:
                self._json(400, {"error": "version required"})
                return
            active = ACTIVE_FILE.read_text().strip() if ACTIVE_FILE.exists() else ""
            if version == active:
                self._json(409, {"error": "Cannot delete the active build"})
                return
            target = BUILDS_DIR / f"{version}.bin"
            if not target.exists():
                self._json(404, {"error": f"Build {version} not found"})
                return
            target.unlink()
            self._json(200, {"ok": True, "deleted": version})
        else:
            self._json(404, {"error": "not found"})


if __name__ == "__main__":
    BUILDS_DIR.mkdir(parents=True, exist_ok=True)
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"feather-ctl listening on :{PORT}")
    server.serve_forever()
