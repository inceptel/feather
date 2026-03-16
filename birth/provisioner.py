#!/usr/bin/env python3
"""Feather Cloud Provisioner — Self-service container management.

Handles cold starts, Stripe webhooks, idle shutdown, and usage metering.
Runs on port 9100 inside the birth container.
"""

import hashlib
import hmac
import json
import logging
import os
import re
import subprocess
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PORT = 9100
TENANT_SH = os.environ.get("TENANT_SH", "/opt/birth/tenant.sh")
TENANT_FILE = os.environ.get("TENANT_FILE", "/data/tenants.json")
DOMAIN_SUFFIX = os.environ.get("DOMAIN_SUFFIX", "feather-cloud.dev")
CADDY_ADMIN = "http://localhost:2020"
PROVISIONER_PORT = 9100
ACCESS_LOG = "/tmp/caddy-access.log"
IDLE_TIMEOUT_SECS = 3600  # 60 min
SPLASH_HTML = os.path.join(os.path.dirname(__file__), "splash.html")
SUCCESS_HTML = os.path.join(os.path.dirname(__file__), "success.html")
SITE_DIR = os.environ.get("SITE_DIR", "/opt/birth/site")

# Stripe (optional — works without for non-billing features)
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID = os.environ.get("STRIPE_PRICE_ID", "")

stripe = None
if STRIPE_SECRET_KEY:
    try:
        import stripe as _stripe
        _stripe.api_key = STRIPE_SECRET_KEY
        stripe = _stripe
    except ImportError:
        logging.warning("stripe module not installed — billing endpoints disabled")

log = logging.getLogger("provisioner")
logging.basicConfig(
    level=logging.INFO,
    format="[provisioner] %(asctime)s %(message)s",
    datefmt="%H:%M:%S",
)

# ---------------------------------------------------------------------------
# Tenant file helpers
# ---------------------------------------------------------------------------
_tenant_lock = threading.Lock()


def read_tenants():
    """Read tenants.json, return dict."""
    try:
        with open(TENANT_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_tenants(data):
    """Atomically write tenants.json."""
    tmp = TENANT_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, TENANT_FILE)


def update_tenant(username, **fields):
    """Thread-safe update of specific tenant fields."""
    with _tenant_lock:
        tenants = read_tenants()
        if username not in tenants:
            return False
        tenants[username].update(fields)
        write_tenants(tenants)
        return True


def get_tenant(username):
    """Get a single tenant dict or None."""
    return read_tenants().get(username)


# ---------------------------------------------------------------------------
# Shell helpers
# ---------------------------------------------------------------------------
def run_tenant_sh(command, username=None, timeout=180):
    """Run tenant.sh with given command. Returns (returncode, stdout, stderr)."""
    cmd = ["bash", TENANT_SH, command]
    if username:
        cmd.append(username)
    env = {**os.environ, "TENANT_FILE": TENANT_FILE, "DOMAIN_SUFFIX": DOMAIN_SUFFIX}
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    return result.returncode, result.stdout, result.stderr


def patch_caddy_route(route_id, upstream):
    """Patch a Caddy route's upstream via admin API."""
    import urllib.request
    url = f"{CADDY_ADMIN}/id/{route_id}/handle/0/upstreams"
    data = json.dumps([{"dial": upstream}]).encode()
    req = urllib.request.Request(url, data=data, method="PATCH")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status == 200
    except Exception as e:
        log.error("Caddy patch failed for %s: %s", route_id, e)
        return False


# ---------------------------------------------------------------------------
# Username generation from email
# ---------------------------------------------------------------------------
def email_to_username(email):
    """Generate a valid username from an email address."""
    local = email.split("@")[0].lower()
    # Keep only alphanumeric and hyphens
    username = re.sub(r"[^a-z0-9-]", "", local)
    # Must start with letter
    username = re.sub(r"^[^a-z]+", "", username)
    # Truncate
    username = username[:20] or "user"
    # If taken, append digits
    tenants = read_tenants()
    base = username
    counter = 1
    while username in tenants:
        suffix = str(counter)
        username = base[: 20 - len(suffix)] + suffix
        counter += 1
    return username


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------
class ProvisionerHandler(BaseHTTPRequestHandler):
    """Routes requests to the appropriate handler."""

    def log_message(self, fmt, *args):
        log.info(fmt, *args)

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, path, status=200):
        try:
            with open(path) as f:
                body = f.read().encode()
        except FileNotFoundError:
            self._send_json({"error": "page not found"}, 404)
            return
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    # --- Routing -----------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        # API routes
        if path.startswith("/api/health/"):
            return self._handle_health(path.split("/")[-1])
        if path == "/api/status":
            return self._handle_status()
        if path == "/api/billing-portal":
            return self._handle_billing_portal()
        if path == "/api/usage":
            return self._handle_usage()

        # Cold start: stopped tenant hitting their subdomain
        host = self.headers.get("Host", "")
        username = self._username_from_host(host)
        if username:
            tenant = get_tenant(username)
            if tenant and tenant.get("status") == "stopped":
                return self._send_html(SPLASH_HTML)

        # Fallback
        self._send_json({"service": "feather-provisioner", "ok": True})

    def do_POST(self):
        path = urlparse(self.path).path

        if path.startswith("/api/wake/"):
            return self._handle_wake(path.split("/")[-1])
        if path == "/api/stripe-webhook":
            return self._handle_stripe_webhook()
        if path == "/api/create-checkout":
            return self._handle_create_checkout()
        if path.startswith("/api/rollback/"):
            return self._handle_rollback(path.split("/")[-1])

        self._send_json({"error": "not found"}, 404)

    # --- Helpers -----------------------------------------------------------

    def _username_from_host(self, host):
        """Extract username from Host header like 'alice.feather-cloud.dev'."""
        host = host.split(":")[0]  # strip port
        if host.endswith("." + DOMAIN_SUFFIX):
            return host[: -(len(DOMAIN_SUFFIX) + 1)]
        return None

    # --- Wake (cold start) -------------------------------------------------

    def _handle_wake(self, username):
        tenant = get_tenant(username)
        if not tenant:
            return self._send_json({"error": "tenant not found"}, 404)

        status = tenant.get("status", "running")
        if status == "running":
            return self._send_json({"status": "already_running"})

        log.info("Waking tenant: %s", username)

        # Start via tenant.sh
        rc, stdout, stderr = run_tenant_sh("start", username)
        if rc != 0:
            log.error("tenant.sh start failed: %s %s", stdout, stderr)
            return self._send_json({"error": "start failed", "detail": stderr.strip()}, 500)

        # Patch Caddy route back to the tenant's port
        port = tenant.get("port")
        route_id = tenant.get("route_id", f"tenant-{username}")
        if port:
            patch_caddy_route(route_id, f"127.0.0.1:{port}")

        self._send_json({"status": "started", "username": username})

    # --- Health check ------------------------------------------------------

    def _handle_health(self, username):
        tenant = get_tenant(username)
        if not tenant:
            return self._send_json({"error": "tenant not found"}, 404)

        port = tenant.get("port")
        status = tenant.get("status", "unknown")

        if status != "running":
            return self._send_json({"healthy": False, "status": status})

        # Proxy health check to the container
        import urllib.request
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as resp:
                healthy = resp.status == 200
        except Exception:
            healthy = False

        self._send_json({"healthy": healthy, "status": status})

    # --- System status -----------------------------------------------------

    def _handle_status(self):
        tenants = read_tenants()
        running = sum(1 for t in tenants.values() if t.get("status") == "running")
        stopped = sum(1 for t in tenants.values() if t.get("status") == "stopped")
        summary = {}
        for name, t in tenants.items():
            summary[name] = {
                "status": t.get("status", "unknown"),
                "port": t.get("port"),
                "subdomain": t.get("subdomain"),
                "last_access": t.get("last_access"),
            }
        self._send_json({
            "total": len(tenants),
            "running": running,
            "stopped": stopped,
            "tenants": summary,
        })

    # --- Usage -------------------------------------------------------------

    def _handle_usage(self):
        tenants = read_tenants()
        usage = {}
        for name, t in tenants.items():
            usage[name] = {
                "compute_seconds_this_period": t.get("compute_seconds_this_period", 0),
                "status": t.get("status", "unknown"),
                "last_access": t.get("last_access"),
            }
        self._send_json(usage)

    # --- Stripe: create checkout -------------------------------------------

    def _handle_create_checkout(self):
        if not stripe:
            return self._send_json({"error": "billing not configured"}, 503)

        body = json.loads(self._read_body() or b"{}")
        email = body.get("email", "").strip()
        if not email:
            return self._send_json({"error": "email required"}, 400)

        try:
            session = stripe.checkout.Session.create(
                payment_method_types=["card"],
                mode="subscription",
                customer_email=email,
                line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
                success_url=f"https://{DOMAIN_SUFFIX}/success?session_id={{CHECKOUT_SESSION_ID}}",
                cancel_url=f"https://{DOMAIN_SUFFIX}",
                metadata={"email": email},
            )
            self._send_json({"url": session.url})
        except Exception as e:
            log.error("Stripe checkout error: %s", e)
            self._send_json({"error": str(e)}, 500)

    # --- Stripe: billing portal --------------------------------------------

    def _handle_billing_portal(self):
        if not stripe:
            return self._send_json({"error": "billing not configured"}, 503)

        # For now, require customer_id as query param
        from urllib.parse import parse_qs
        qs = parse_qs(urlparse(self.path).query)
        customer_id = (qs.get("customer_id") or [None])[0]
        if not customer_id:
            return self._send_json({"error": "customer_id required"}, 400)

        try:
            session = stripe.billing_portal.Session.create(
                customer=customer_id,
                return_url=f"https://{DOMAIN_SUFFIX}",
            )
            self.send_response(302)
            self.send_header("Location", session.url)
            self.end_headers()
        except Exception as e:
            log.error("Stripe portal error: %s", e)
            self._send_json({"error": str(e)}, 500)

    # --- Stripe: webhook ---------------------------------------------------

    def _handle_stripe_webhook(self):
        if not stripe:
            return self._send_json({"error": "billing not configured"}, 503)

        payload = self._read_body()
        sig = self.headers.get("Stripe-Signature", "")

        try:
            event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
        except Exception as e:
            log.error("Webhook signature verification failed: %s", e)
            return self._send_json({"error": "invalid signature"}, 400)

        event_type = event["type"]
        log.info("Stripe event: %s", event_type)

        if event_type == "checkout.session.completed":
            self._on_checkout_completed(event["data"]["object"])
        elif event_type == "customer.subscription.deleted":
            self._on_subscription_deleted(event["data"]["object"])
        elif event_type == "invoice.payment_failed":
            self._on_payment_failed(event["data"]["object"])

        self._send_json({"received": True})

    def _on_checkout_completed(self, session):
        email = session.get("customer_email") or session.get("metadata", {}).get("email", "")
        customer_id = session.get("customer", "")
        subscription_id = session.get("subscription", "")

        if not email:
            log.error("Checkout completed but no email found")
            return

        username = email_to_username(email)
        log.info("Provisioning new tenant: %s (email: %s)", username, email)

        rc, stdout, stderr = run_tenant_sh("add", username)
        if rc != 0:
            log.error("Provisioning failed for %s: %s", username, stderr)
            return

        # Store Stripe IDs
        update_tenant(username,
                      stripe_customer_id=customer_id,
                      stripe_subscription_id=subscription_id)
        log.info("Tenant %s provisioned with Stripe customer %s", username, customer_id)

    def _on_subscription_deleted(self, subscription):
        customer_id = subscription.get("customer", "")
        tenants = read_tenants()
        for username, t in tenants.items():
            if t.get("stripe_customer_id") == customer_id:
                log.info("Subscription deleted for %s — stopping", username)
                run_tenant_sh("stop", username)
                return
        log.warning("Subscription deleted but no matching tenant for customer %s", customer_id)

    def _on_payment_failed(self, invoice):
        customer_id = invoice.get("customer", "")
        tenants = read_tenants()
        for username, t in tenants.items():
            if t.get("stripe_customer_id") == customer_id:
                log.info("Payment failed for %s — stopping container", username)
                run_tenant_sh("stop", username)
                return

    # --- Rollback ----------------------------------------------------------

    def _handle_rollback(self, username):
        tenant = get_tenant(username)
        if not tenant:
            return self._send_json({"error": "tenant not found"}, 404)

        image_tags = tenant.get("image_tags", [])
        active = tenant.get("active_image_tag", "")

        if len(image_tags) < 2:
            return self._send_json({"error": "no previous image to rollback to"}, 400)

        # Find previous tag
        try:
            idx = image_tags.index(active)
            prev_tag = image_tags[idx - 1] if idx > 0 else None
        except ValueError:
            prev_tag = image_tags[-2] if len(image_tags) >= 2 else None

        if not prev_tag:
            return self._send_json({"error": "no previous image to rollback to"}, 400)

        log.info("Rolling back %s from %s to %s", username, active, prev_tag)

        # Stop current container
        run_tenant_sh("stop", username)

        # Update image tag and restart
        with _tenant_lock:
            tenants = read_tenants()
            if username in tenants:
                tenants[username]["active_image_tag"] = prev_tag
                write_tenants(tenants)

        # Set WORK_IMAGE env for tenant.sh start
        os.environ["WORK_IMAGE"] = prev_tag
        rc, stdout, stderr = run_tenant_sh("start", username)
        # Restore
        os.environ.pop("WORK_IMAGE", None)

        if rc != 0:
            return self._send_json({"error": "rollback start failed", "detail": stderr.strip()}, 500)

        self._send_json({"status": "rolled_back", "from": active, "to": prev_tag})


# ---------------------------------------------------------------------------
# Background thread: Idle Monitor
# ---------------------------------------------------------------------------
class IdleMonitor(threading.Thread):
    """Stops containers that have been idle for IDLE_TIMEOUT_SECS.

    Parses Caddy JSON access log to determine last request time per host.
    When a container is idle, patches its Caddy route to point at the
    provisioner so the next request triggers a cold start.
    """

    daemon = True

    def run(self):
        log.info("IdleMonitor started (timeout: %ds)", IDLE_TIMEOUT_SECS)
        while True:
            time.sleep(60)
            try:
                self._check()
            except Exception as e:
                log.error("IdleMonitor error: %s", e)

    def _check(self):
        last_seen = self._parse_access_log()
        now = time.time()
        tenants = read_tenants()

        for username, t in tenants.items():
            if t.get("status") != "running":
                continue

            subdomain = t.get("subdomain", "")
            last_req = last_seen.get(subdomain, 0)

            # If no log entry, use last_access from tenants.json
            if last_req == 0:
                la = t.get("last_access", "")
                if la:
                    try:
                        import datetime
                        dt = datetime.datetime.fromisoformat(la.replace("Z", "+00:00"))
                        last_req = dt.timestamp()
                    except Exception:
                        pass

            idle_secs = now - last_req if last_req else IDLE_TIMEOUT_SECS + 1

            if idle_secs > IDLE_TIMEOUT_SECS:
                log.info("Idle shutdown: %s (idle %.0fs)", username, idle_secs)
                run_tenant_sh("stop", username)
                # Patch Caddy route to provisioner for cold start
                route_id = t.get("route_id", f"tenant-{username}")
                patch_caddy_route(route_id, f"127.0.0.1:{PROVISIONER_PORT}")
            else:
                # Update last_access
                update_tenant(username, last_access=time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_req)))

    def _parse_access_log(self):
        """Parse Caddy JSON access log, return {host: last_unix_timestamp}."""
        last_seen = {}
        try:
            with open(ACCESS_LOG) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        host = entry.get("request", {}).get("host", "")
                        ts = entry.get("ts", 0)
                        if host and ts:
                            last_seen[host] = max(last_seen.get(host, 0), ts)
                    except json.JSONDecodeError:
                        continue
        except FileNotFoundError:
            pass
        return last_seen


# ---------------------------------------------------------------------------
# Background thread: Usage Meter
# ---------------------------------------------------------------------------
class UsageMeter(threading.Thread):
    """Every hour, tallies compute seconds for running containers and
    optionally reports to Stripe metered billing."""

    daemon = True

    def run(self):
        log.info("UsageMeter started")
        while True:
            time.sleep(3600)  # every hour
            try:
                self._meter()
            except Exception as e:
                log.error("UsageMeter error: %s", e)

    def _meter(self):
        with _tenant_lock:
            tenants = read_tenants()
            changed = False
            for username, t in tenants.items():
                if t.get("status") == "running":
                    prev = t.get("compute_seconds_this_period", 0)
                    t["compute_seconds_this_period"] = prev + 3600
                    changed = True

                    # Report to Stripe if configured
                    if stripe and t.get("stripe_subscription_id"):
                        self._report_stripe_usage(t["stripe_subscription_id"], 3600)

            if changed:
                write_tenants(tenants)

    def _report_stripe_usage(self, subscription_id, seconds):
        """Report usage to Stripe metered billing."""
        try:
            # Get the subscription item for metered billing
            sub = stripe.Subscription.retrieve(subscription_id)
            for item in sub["items"]["data"]:
                stripe.SubscriptionItem.create_usage_record(
                    item["id"],
                    quantity=seconds // 3600,  # report in hours
                    timestamp=int(time.time()),
                    action="increment",
                )
                break
        except Exception as e:
            log.error("Stripe usage report failed: %s", e)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    # Ensure tenant file directory exists
    Path(TENANT_FILE).parent.mkdir(parents=True, exist_ok=True)
    if not Path(TENANT_FILE).exists():
        write_tenants({})

    # Start background threads
    IdleMonitor().start()
    UsageMeter().start()

    # Start HTTP server
    server = HTTPServer(("127.0.0.1", PORT), ProvisionerHandler)
    log.info("Provisioner listening on 127.0.0.1:%d", PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
