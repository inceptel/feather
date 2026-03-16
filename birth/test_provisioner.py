#!/usr/bin/env python3
"""Tests for Feather Cloud Provisioner.

Uses unittest.mock to avoid needing podman, Caddy, or Stripe.
Run: python3 -m pytest birth/test_provisioner.py -v
  or: python3 birth/test_provisioner.py
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import HTTPServer
from io import BytesIO
from unittest.mock import MagicMock, patch, call

# Set up test environment before importing provisioner
TEST_DIR = tempfile.mkdtemp()
TENANT_FILE = os.path.join(TEST_DIR, "tenants.json")
os.environ["TENANT_FILE"] = TENANT_FILE
os.environ["DOMAIN_SUFFIX"] = "feather-cloud.dev"
os.environ["TENANT_SH"] = "/opt/birth/tenant.sh"

sys.path.insert(0, os.path.dirname(__file__))
import provisioner


# ---------------------------------------------------------------------------
# Shared helper to build mock HTTP handlers
# ---------------------------------------------------------------------------
def make_handler(method, path, body=b"", headers=None):
    handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
    handler.path = path
    handler.command = method
    handler.headers = headers or {}
    if "Content-Length" not in handler.headers and body:
        handler.headers["Content-Length"] = str(len(body))
    handler.rfile = BytesIO(body)
    handler.requestline = f"{method} {path} HTTP/1.1"
    handler.client_address = ("127.0.0.1", 12345)
    handler._response_code = None
    handler._response_headers = {}

    def mock_send_response(code, message=None):
        handler._response_code = code

    def mock_send_header(key, value):
        handler._response_headers[key] = value

    def mock_end_headers():
        pass

    handler.send_response = mock_send_response
    handler.send_header = mock_send_header
    handler.end_headers = mock_end_headers
    real_wfile = BytesIO()
    handler.wfile = real_wfile
    return handler, real_wfile


# ===================================================================
# 1. Tenant file operations (8 tests)
# ===================================================================
class TestTenantFileOps(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE
        provisioner.write_tenants({})

    def test_read_empty(self):
        self.assertEqual(provisioner.read_tenants(), {})

    def test_write_and_read(self):
        provisioner.write_tenants({"alice": {"port": 9001, "status": "running"}})
        data = provisioner.read_tenants()
        self.assertEqual(data["alice"]["port"], 9001)

    def test_update_tenant(self):
        provisioner.write_tenants({"alice": {"port": 9001, "status": "running"}})
        self.assertTrue(provisioner.update_tenant("alice", status="stopped"))
        self.assertEqual(provisioner.read_tenants()["alice"]["status"], "stopped")

    def test_update_nonexistent(self):
        self.assertFalse(provisioner.update_tenant("nobody", status="stopped"))

    def test_get_tenant(self):
        provisioner.write_tenants({"bob": {"port": 9002}})
        self.assertEqual(provisioner.get_tenant("bob")["port"], 9002)
        self.assertIsNone(provisioner.get_tenant("nobody"))

    def test_read_missing_file(self):
        provisioner.TENANT_FILE = "/tmp/does-not-exist-12345.json"
        self.assertEqual(provisioner.read_tenants(), {})
        provisioner.TENANT_FILE = TENANT_FILE

    def test_read_corrupt_json(self):
        """Corrupt JSON returns empty dict instead of crashing."""
        corrupt = os.path.join(TEST_DIR, "corrupt.json")
        with open(corrupt, "w") as f:
            f.write("{not valid json")
        provisioner.TENANT_FILE = corrupt
        self.assertEqual(provisioner.read_tenants(), {})
        provisioner.TENANT_FILE = TENANT_FILE

    def test_update_multiple_fields(self):
        """update_tenant can set multiple fields at once."""
        provisioner.write_tenants({"alice": {"port": 9001, "status": "running", "x": 1}})
        provisioner.update_tenant("alice", status="stopped", x=99, new_field="hello")
        t = provisioner.read_tenants()["alice"]
        self.assertEqual(t["status"], "stopped")
        self.assertEqual(t["x"], 99)
        self.assertEqual(t["new_field"], "hello")


# ===================================================================
# 2. Email to username (8 tests)
# ===================================================================
class TestEmailToUsername(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE
        provisioner.write_tenants({})

    def test_simple_email(self):
        self.assertEqual(provisioner.email_to_username("alice@example.com"), "alice")

    def test_email_with_dots(self):
        self.assertEqual(provisioner.email_to_username("alice.smith@example.com"), "alicesmith")

    def test_email_with_numbers(self):
        self.assertEqual(provisioner.email_to_username("alice123@example.com"), "alice123")

    def test_email_leading_numbers(self):
        self.assertEqual(provisioner.email_to_username("123alice@example.com"), "alice")

    def test_collision(self):
        provisioner.write_tenants({"alice": {"port": 9001}})
        self.assertEqual(provisioner.email_to_username("alice@example.com"), "alice1")

    def test_double_collision(self):
        provisioner.write_tenants({"alice": {"port": 9001}, "alice1": {"port": 9002}})
        self.assertEqual(provisioner.email_to_username("alice@example.com"), "alice2")

    def test_special_characters_stripped(self):
        self.assertEqual(provisioner.email_to_username("a+l!i#ce@example.com"), "alice")

    def test_all_numbers_fallback(self):
        """All-numeric local part falls back to 'user'."""
        self.assertEqual(provisioner.email_to_username("12345@example.com"), "user")

    def test_long_email_truncated(self):
        """Very long local part is truncated to 20 chars."""
        name = provisioner.email_to_username("abcdefghijklmnopqrstuvwxyz@x.com")
        self.assertEqual(len(name), 20)
        self.assertEqual(name, "abcdefghijklmnopqrst")

    def test_hyphenated_email(self):
        self.assertEqual(provisioner.email_to_username("alice-bob@example.com"), "alice-bob")

    def test_uppercase_normalized(self):
        self.assertEqual(provisioner.email_to_username("Alice@Example.COM"), "alice")

    def test_empty_local_part_fallback(self):
        """Edge case: @ at start."""
        self.assertEqual(provisioner.email_to_username("@example.com"), "user")


# ===================================================================
# 3. HTTP handler — status/health/usage (11 tests)
# ===================================================================
class TestHTTPEndpoints(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE
        provisioner.write_tenants({
            "alice": {
                "port": 9001, "container": "feather-user-alice",
                "volume": "feather-user-alice",
                "subdomain": "alice.feather-cloud.dev",
                "password": "abc123", "route_id": "tenant-alice",
                "status": "running", "last_access": "2026-02-28T00:00:00Z",
                "stripe_customer_id": None, "stripe_subscription_id": None,
                "image_tags": ["localhost/feather-work:latest"],
                "active_image_tag": "localhost/feather-work:latest",
                "compute_seconds_this_period": 0,
            },
            "bob": {
                "port": 9002, "container": "feather-user-bob",
                "volume": "feather-user-bob",
                "subdomain": "bob.feather-cloud.dev",
                "password": "def456", "route_id": "tenant-bob",
                "status": "stopped", "last_access": "2026-02-27T00:00:00Z",
                "stripe_customer_id": "cus_test123",
                "stripe_subscription_id": "sub_test123",
                "image_tags": ["localhost/feather-work:v1", "localhost/feather-work:v2"],
                "active_image_tag": "localhost/feather-work:v2",
                "compute_seconds_this_period": 7200,
            },
        })

    def test_status_endpoint(self):
        h, w = make_handler("GET", "/api/status")
        h.do_GET()
        body = json.loads(w.getvalue())
        self.assertEqual(body["total"], 2)
        self.assertEqual(body["running"], 1)
        self.assertEqual(body["stopped"], 1)
        self.assertIn("alice", body["tenants"])
        self.assertIn("bob", body["tenants"])

    def test_status_empty_tenants(self):
        provisioner.write_tenants({})
        h, w = make_handler("GET", "/api/status")
        h.do_GET()
        body = json.loads(w.getvalue())
        self.assertEqual(body["total"], 0)
        self.assertEqual(body["running"], 0)
        self.assertEqual(body["tenants"], {})

    def test_health_running_tenant(self):
        h, w = make_handler("GET", "/api/health/alice")
        with patch("urllib.request.urlopen") as mock:
            resp = MagicMock()
            resp.status = 200
            resp.__enter__ = MagicMock(return_value=resp)
            resp.__exit__ = MagicMock(return_value=False)
            mock.return_value = resp
            h.do_GET()
        body = json.loads(w.getvalue())
        self.assertTrue(body["healthy"])

    def test_health_stopped_tenant(self):
        h, w = make_handler("GET", "/api/health/bob")
        h.do_GET()
        body = json.loads(w.getvalue())
        self.assertFalse(body["healthy"])
        self.assertEqual(body["status"], "stopped")

    def test_health_unknown_tenant(self):
        h, w = make_handler("GET", "/api/health/nobody")
        h.do_GET()
        self.assertEqual(h._response_code, 404)

    def test_health_container_unreachable(self):
        """Running tenant whose container doesn't respond."""
        h, w = make_handler("GET", "/api/health/alice")
        with patch("urllib.request.urlopen", side_effect=Exception("connection refused")):
            h.do_GET()
        body = json.loads(w.getvalue())
        self.assertFalse(body["healthy"])
        self.assertEqual(body["status"], "running")

    def test_usage_endpoint(self):
        h, w = make_handler("GET", "/api/usage")
        h.do_GET()
        body = json.loads(w.getvalue())
        self.assertEqual(body["alice"]["compute_seconds_this_period"], 0)
        self.assertEqual(body["bob"]["compute_seconds_this_period"], 7200)

    def test_usage_empty_tenants(self):
        provisioner.write_tenants({})
        h, w = make_handler("GET", "/api/usage")
        h.do_GET()
        self.assertEqual(json.loads(w.getvalue()), {})

    def test_options_cors(self):
        h, w = make_handler("OPTIONS", "/api/status")
        h.do_OPTIONS()
        self.assertEqual(h._response_code, 200)
        self.assertEqual(h._response_headers.get("Access-Control-Allow-Origin"), "*")

    def test_fallback_json_response(self):
        """Unknown GET path returns service info."""
        h, w = make_handler("GET", "/random/path", headers={"Host": "somewhere.else"})
        h.do_GET()
        body = json.loads(w.getvalue())
        self.assertTrue(body["ok"])
        self.assertEqual(body["service"], "feather-provisioner")

    def test_post_unknown_path_404(self):
        h, w = make_handler("POST", "/api/nonexistent")
        h.do_POST()
        self.assertEqual(h._response_code, 404)


# ===================================================================
# 4. Wake / cold start (8 tests)
# ===================================================================
class TestWake(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE
        provisioner.write_tenants({
            "alice": {"port": 9001, "route_id": "tenant-alice", "status": "running",
                      "subdomain": "alice.feather-cloud.dev"},
            "bob": {"port": 9002, "route_id": "tenant-bob", "status": "stopped",
                    "subdomain": "bob.feather-cloud.dev"},
        })

    @patch("provisioner.run_tenant_sh")
    @patch("provisioner.patch_caddy_route")
    def test_wake_stopped_tenant(self, mock_patch, mock_run):
        mock_run.return_value = (0, "started", "")
        mock_patch.return_value = True
        h, w = make_handler("POST", "/api/wake/bob")
        h.do_POST()
        body = json.loads(w.getvalue())
        self.assertEqual(body["status"], "started")
        self.assertEqual(body["username"], "bob")
        mock_run.assert_called_once_with("start", "bob")
        mock_patch.assert_called_once_with("tenant-bob", "127.0.0.1:9002")

    @patch("provisioner.run_tenant_sh")
    def test_wake_already_running(self, mock_run):
        h, w = make_handler("POST", "/api/wake/alice")
        h.do_POST()
        body = json.loads(w.getvalue())
        self.assertEqual(body["status"], "already_running")
        mock_run.assert_not_called()

    def test_wake_unknown_tenant(self):
        h, w = make_handler("POST", "/api/wake/nobody")
        h.do_POST()
        self.assertEqual(h._response_code, 404)

    @patch("provisioner.run_tenant_sh")
    @patch("provisioner.patch_caddy_route")
    def test_wake_start_failure(self, mock_patch, mock_run):
        """tenant.sh start fails → 500 with error detail."""
        mock_run.return_value = (1, "", "container start timeout")
        h, w = make_handler("POST", "/api/wake/bob")
        h.do_POST()
        self.assertEqual(h._response_code, 500)
        body = json.loads(w.getvalue())
        self.assertIn("start failed", body["error"])
        self.assertIn("timeout", body["detail"])
        mock_patch.assert_not_called()

    def test_cold_start_splash_served(self):
        """Stopped tenant hitting their subdomain gets splash page."""
        # Write a real temp splash file
        splash = os.path.join(TEST_DIR, "test-splash.html")
        with open(splash, "w") as f:
            f.write("<html>splash</html>")
        old = provisioner.SPLASH_HTML
        provisioner.SPLASH_HTML = splash
        h, w = make_handler("GET", "/", headers={"Host": "bob.feather-cloud.dev"})
        h.do_GET()
        self.assertEqual(h._response_code, 200)
        self.assertEqual(h._response_headers.get("Content-Type"), "text/html")
        self.assertIn(b"splash", w.getvalue())
        provisioner.SPLASH_HTML = old

    def test_running_tenant_no_splash(self):
        """Running tenant doesn't get splash."""
        h, w = make_handler("GET", "/", headers={"Host": "alice.feather-cloud.dev"})
        h.do_GET()
        body = json.loads(w.getvalue())
        self.assertTrue(body["ok"])

    def test_bare_domain_no_splash(self):
        """Bare domain (no subdomain) doesn't trigger splash."""
        h, w = make_handler("GET", "/", headers={"Host": "feather-cloud.dev"})
        h.do_GET()
        body = json.loads(w.getvalue())
        self.assertTrue(body["ok"])

    def test_splash_missing_file_404(self):
        """If splash.html is missing, return 404 JSON."""
        old = provisioner.SPLASH_HTML
        provisioner.SPLASH_HTML = "/tmp/nonexistent-splash-12345.html"
        h, w = make_handler("GET", "/", headers={"Host": "bob.feather-cloud.dev"})
        h.do_GET()
        self.assertEqual(h._response_code, 404)
        provisioner.SPLASH_HTML = old


# ===================================================================
# 5. Host header parsing (5 tests)
# ===================================================================
class TestHostParsing(unittest.TestCase):

    def _parse(self, host):
        h, _ = make_handler("GET", "/")
        return h._username_from_host(host)

    def test_valid_subdomain(self):
        self.assertEqual(self._parse("alice.feather-cloud.dev"), "alice")

    def test_with_port(self):
        self.assertEqual(self._parse("alice.feather-cloud.dev:443"), "alice")

    def test_bare_domain(self):
        self.assertIsNone(self._parse("feather-cloud.dev"))

    def test_unrelated_domain(self):
        self.assertIsNone(self._parse("google.com"))

    def test_empty_host(self):
        self.assertIsNone(self._parse(""))


# ===================================================================
# 6. Rollback (6 tests)
# ===================================================================
class TestRollback(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE
        provisioner.write_tenants({
            "charlie": {
                "port": 9003, "container": "feather-user-charlie",
                "volume": "feather-user-charlie",
                "subdomain": "charlie.feather-cloud.dev",
                "password": "ghi789", "route_id": "tenant-charlie",
                "status": "running",
                "image_tags": ["localhost/feather-work:v1", "localhost/feather-work:v2"],
                "active_image_tag": "localhost/feather-work:v2",
                "compute_seconds_this_period": 0,
            },
            "dave": {
                "port": 9004, "container": "feather-user-dave",
                "volume": "feather-user-dave",
                "subdomain": "dave.feather-cloud.dev",
                "password": "jkl012", "route_id": "tenant-dave",
                "status": "running",
                "image_tags": ["localhost/feather-work:latest"],
                "active_image_tag": "localhost/feather-work:latest",
                "compute_seconds_this_period": 0,
            },
        })

    @patch("provisioner.run_tenant_sh")
    def test_rollback_success(self, mock_run):
        mock_run.return_value = (0, "ok", "")
        h, w = make_handler("POST", "/api/rollback/charlie")
        h.do_POST()
        body = json.loads(w.getvalue())
        self.assertEqual(body["status"], "rolled_back")
        self.assertEqual(body["from"], "localhost/feather-work:v2")
        self.assertEqual(body["to"], "localhost/feather-work:v1")

    @patch("provisioner.run_tenant_sh")
    def test_rollback_updates_tenants_json(self, mock_run):
        mock_run.return_value = (0, "ok", "")
        h, w = make_handler("POST", "/api/rollback/charlie")
        h.do_POST()
        t = provisioner.get_tenant("charlie")
        self.assertEqual(t["active_image_tag"], "localhost/feather-work:v1")

    def test_rollback_no_previous(self):
        h, w = make_handler("POST", "/api/rollback/dave")
        h.do_POST()
        self.assertEqual(h._response_code, 400)

    def test_rollback_unknown_tenant(self):
        h, w = make_handler("POST", "/api/rollback/nobody")
        h.do_POST()
        self.assertEqual(h._response_code, 404)

    @patch("provisioner.run_tenant_sh")
    def test_rollback_start_fails(self, mock_run):
        """Rollback stops container but start fails → 500."""
        mock_run.side_effect = [(0, "", ""), (1, "", "image not found")]
        h, w = make_handler("POST", "/api/rollback/charlie")
        h.do_POST()
        self.assertEqual(h._response_code, 500)
        body = json.loads(w.getvalue())
        self.assertIn("rollback start failed", body["error"])

    @patch("provisioner.run_tenant_sh")
    def test_rollback_with_three_images(self, mock_run):
        """Rollback picks the image right before active."""
        mock_run.return_value = (0, "ok", "")
        provisioner.write_tenants({
            "eve": {
                "port": 9005, "container": "c", "volume": "v",
                "subdomain": "eve.feather-cloud.dev", "password": "p",
                "route_id": "tenant-eve", "status": "running",
                "image_tags": ["v1", "v2", "v3"],
                "active_image_tag": "v3",
                "compute_seconds_this_period": 0,
            }
        })
        h, w = make_handler("POST", "/api/rollback/eve")
        h.do_POST()
        body = json.loads(w.getvalue())
        self.assertEqual(body["to"], "v2")


# ===================================================================
# 7. Stripe webhooks (8 tests)
# ===================================================================
class TestStripeWebhook(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE
        provisioner.write_tenants({})

    @patch("provisioner.run_tenant_sh")
    def test_checkout_completed_provisions(self, mock_run):
        mock_run.return_value = (0, "provisioned", "")
        handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
        handler._on_checkout_completed({
            "customer_email": "newuser@example.com",
            "customer": "cus_new123",
            "subscription": "sub_new123",
            "metadata": {},
        })
        mock_run.assert_called_once_with("add", "newuser")

    @patch("provisioner.run_tenant_sh")
    def test_checkout_uses_metadata_email_fallback(self, mock_run):
        """Falls back to metadata.email when customer_email is empty."""
        mock_run.return_value = (0, "", "")
        handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
        handler._on_checkout_completed({
            "customer_email": "",
            "customer": "cus_x",
            "subscription": "sub_x",
            "metadata": {"email": "meta@example.com"},
        })
        mock_run.assert_called_once_with("add", "meta")

    @patch("provisioner.run_tenant_sh")
    def test_checkout_no_email_skips(self, mock_run):
        """No email at all → skip provisioning."""
        handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
        handler._on_checkout_completed({
            "customer_email": "",
            "customer": "cus_x",
            "subscription": "sub_x",
            "metadata": {},
        })
        mock_run.assert_not_called()

    @patch("provisioner.run_tenant_sh")
    def test_checkout_provision_failure(self, mock_run):
        """tenant.sh add fails — no crash, no stripe ID update."""
        mock_run.return_value = (1, "", "port exhausted")
        handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
        handler._on_checkout_completed({
            "customer_email": "fail@example.com",
            "customer": "cus_f",
            "subscription": "sub_f",
            "metadata": {},
        })
        self.assertIsNone(provisioner.get_tenant("fail"))

    @patch("provisioner.run_tenant_sh")
    def test_subscription_deleted_stops(self, mock_run):
        mock_run.return_value = (0, "stopped", "")
        provisioner.write_tenants({
            "alice": {"port": 9001, "status": "running", "stripe_customer_id": "cus_alice"}
        })
        handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
        handler._on_subscription_deleted({"customer": "cus_alice"})
        mock_run.assert_called_once_with("stop", "alice")

    @patch("provisioner.run_tenant_sh")
    def test_subscription_deleted_no_match(self, mock_run):
        """Unknown customer → no action."""
        provisioner.write_tenants({})
        handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
        handler._on_subscription_deleted({"customer": "cus_unknown"})
        mock_run.assert_not_called()

    @patch("provisioner.run_tenant_sh")
    def test_payment_failed_stops(self, mock_run):
        mock_run.return_value = (0, "stopped", "")
        provisioner.write_tenants({
            "bob": {"port": 9002, "status": "running", "stripe_customer_id": "cus_bob"}
        })
        handler = provisioner.ProvisionerHandler.__new__(provisioner.ProvisionerHandler)
        handler._on_payment_failed({"customer": "cus_bob"})
        mock_run.assert_called_once_with("stop", "bob")

    def test_webhook_invalid_sig_returns_400(self):
        provisioner.stripe = MagicMock()
        provisioner.stripe.Webhook.construct_event.side_effect = Exception("bad sig")
        h, w = make_handler(
            "POST", "/api/stripe-webhook",
            body=b'{"type":"test"}',
            headers={"Stripe-Signature": "bad", "Content-Length": "15"},
        )
        h.do_POST()
        self.assertEqual(h._response_code, 400)
        provisioner.stripe = None


# ===================================================================
# 8. Stripe billing endpoints (5 tests)
# ===================================================================
class TestStripeBilling(unittest.TestCase):

    def test_create_checkout_no_stripe(self):
        """Without stripe configured, returns 503."""
        old = provisioner.stripe
        provisioner.stripe = None
        h, w = make_handler("POST", "/api/create-checkout",
                            body=b'{"email":"a@b.com"}')
        h.do_POST()
        self.assertEqual(h._response_code, 503)
        provisioner.stripe = old

    def test_create_checkout_missing_email(self):
        provisioner.stripe = MagicMock()
        h, w = make_handler("POST", "/api/create-checkout", body=b'{}')
        h.do_POST()
        self.assertEqual(h._response_code, 400)
        body = json.loads(w.getvalue())
        self.assertEqual(body["error"], "email required")
        provisioner.stripe = None

    def test_create_checkout_success(self):
        mock_stripe = MagicMock()
        mock_session = MagicMock()
        mock_session.url = "https://checkout.stripe.com/session123"
        mock_stripe.checkout.Session.create.return_value = mock_session
        provisioner.stripe = mock_stripe
        h, w = make_handler("POST", "/api/create-checkout",
                            body=b'{"email":"test@example.com"}')
        h.do_POST()
        body = json.loads(w.getvalue())
        self.assertEqual(body["url"], "https://checkout.stripe.com/session123")
        provisioner.stripe = None

    def test_billing_portal_no_stripe(self):
        old = provisioner.stripe
        provisioner.stripe = None
        h, w = make_handler("GET", "/api/billing-portal")
        h.do_GET()
        self.assertEqual(h._response_code, 503)
        provisioner.stripe = old

    def test_billing_portal_missing_customer_id(self):
        provisioner.stripe = MagicMock()
        h, w = make_handler("GET", "/api/billing-portal")
        h.do_GET()
        self.assertEqual(h._response_code, 400)
        body = json.loads(w.getvalue())
        self.assertEqual(body["error"], "customer_id required")
        provisioner.stripe = None


# ===================================================================
# 9. Idle shutdown (7 tests)
# ===================================================================
class TestIdleShutdown(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE

    def test_parse_access_log(self):
        log_file = os.path.join(TEST_DIR, "test-access.log")
        with open(log_file, "w") as f:
            f.write(json.dumps({"request": {"host": "alice.feather-cloud.dev"}, "ts": 1000.0}) + "\n")
            f.write(json.dumps({"request": {"host": "alice.feather-cloud.dev"}, "ts": 2000.0}) + "\n")
            f.write(json.dumps({"request": {"host": "bob.feather-cloud.dev"}, "ts": 1500.0}) + "\n")

        monitor = provisioner.IdleMonitor()
        old = provisioner.ACCESS_LOG
        provisioner.ACCESS_LOG = log_file
        last_seen = monitor._parse_access_log()
        provisioner.ACCESS_LOG = old
        self.assertEqual(last_seen["alice.feather-cloud.dev"], 2000.0)
        self.assertEqual(last_seen["bob.feather-cloud.dev"], 1500.0)

    def test_parse_empty_access_log(self):
        log_file = os.path.join(TEST_DIR, "empty-log.log")
        with open(log_file, "w") as f:
            pass
        monitor = provisioner.IdleMonitor()
        old = provisioner.ACCESS_LOG
        provisioner.ACCESS_LOG = log_file
        self.assertEqual(monitor._parse_access_log(), {})
        provisioner.ACCESS_LOG = old

    def test_parse_missing_access_log(self):
        monitor = provisioner.IdleMonitor()
        old = provisioner.ACCESS_LOG
        provisioner.ACCESS_LOG = "/tmp/totally-missing-log-12345.log"
        self.assertEqual(monitor._parse_access_log(), {})
        provisioner.ACCESS_LOG = old

    def test_parse_malformed_lines_skipped(self):
        log_file = os.path.join(TEST_DIR, "malformed.log")
        with open(log_file, "w") as f:
            f.write("not json at all\n")
            f.write("{}\n")  # valid json but no fields
            f.write(json.dumps({"request": {"host": "a.feather-cloud.dev"}, "ts": 99.0}) + "\n")
        monitor = provisioner.IdleMonitor()
        old = provisioner.ACCESS_LOG
        provisioner.ACCESS_LOG = log_file
        last_seen = monitor._parse_access_log()
        provisioner.ACCESS_LOG = old
        self.assertEqual(len(last_seen), 1)
        self.assertEqual(last_seen["a.feather-cloud.dev"], 99.0)

    @patch("provisioner.run_tenant_sh")
    @patch("provisioner.patch_caddy_route")
    def test_idle_container_stopped(self, mock_patch, mock_run):
        mock_run.return_value = (0, "", "")
        mock_patch.return_value = True
        provisioner.write_tenants({
            "idle-user": {
                "port": 9005, "container": "c", "subdomain": "idle-user.feather-cloud.dev",
                "route_id": "tenant-idle-user", "status": "running",
                "last_access": "2020-01-01T00:00:00Z",
            }
        })
        log_file = os.path.join(TEST_DIR, "empty-idle.log")
        with open(log_file, "w") as f:
            pass
        old = provisioner.ACCESS_LOG
        provisioner.ACCESS_LOG = log_file
        provisioner.IdleMonitor()._check()
        provisioner.ACCESS_LOG = old
        mock_run.assert_called_once_with("stop", "idle-user")
        mock_patch.assert_called_once_with("tenant-idle-user", "127.0.0.1:9100")

    @patch("provisioner.run_tenant_sh")
    @patch("provisioner.patch_caddy_route")
    def test_active_container_preserved(self, mock_patch, mock_run):
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        provisioner.write_tenants({
            "active-user": {
                "port": 9006, "container": "c",
                "subdomain": "active-user.feather-cloud.dev",
                "route_id": "tenant-active-user", "status": "running",
                "last_access": now_iso,
            }
        })
        log_file = os.path.join(TEST_DIR, "recent.log")
        with open(log_file, "w") as f:
            f.write(json.dumps({
                "request": {"host": "active-user.feather-cloud.dev"},
                "ts": time.time(),
            }) + "\n")
        old = provisioner.ACCESS_LOG
        provisioner.ACCESS_LOG = log_file
        provisioner.IdleMonitor()._check()
        provisioner.ACCESS_LOG = old
        mock_run.assert_not_called()

    @patch("provisioner.run_tenant_sh")
    @patch("provisioner.patch_caddy_route")
    def test_stopped_containers_skipped(self, mock_patch, mock_run):
        """Already-stopped containers are not re-stopped."""
        provisioner.write_tenants({
            "already-stopped": {
                "port": 9007, "container": "c",
                "subdomain": "already-stopped.feather-cloud.dev",
                "route_id": "tenant-already-stopped", "status": "stopped",
                "last_access": "2020-01-01T00:00:00Z",
            }
        })
        log_file = os.path.join(TEST_DIR, "empty-skip.log")
        with open(log_file, "w") as f:
            pass
        old = provisioner.ACCESS_LOG
        provisioner.ACCESS_LOG = log_file
        provisioner.IdleMonitor()._check()
        provisioner.ACCESS_LOG = old
        mock_run.assert_not_called()


# ===================================================================
# 10. Usage meter (5 tests)
# ===================================================================
class TestUsageMeter(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE

    def test_meter_increments_running(self):
        provisioner.write_tenants({
            "running": {"status": "running", "compute_seconds_this_period": 1000},
            "stopped": {"status": "stopped", "compute_seconds_this_period": 500},
        })
        provisioner.UsageMeter()._meter()
        tenants = provisioner.read_tenants()
        self.assertEqual(tenants["running"]["compute_seconds_this_period"], 4600)
        self.assertEqual(tenants["stopped"]["compute_seconds_this_period"], 500)

    def test_meter_multiple_running(self):
        provisioner.write_tenants({
            "a": {"status": "running", "compute_seconds_this_period": 0},
            "b": {"status": "running", "compute_seconds_this_period": 100},
            "c": {"status": "stopped", "compute_seconds_this_period": 200},
        })
        provisioner.UsageMeter()._meter()
        tenants = provisioner.read_tenants()
        self.assertEqual(tenants["a"]["compute_seconds_this_period"], 3600)
        self.assertEqual(tenants["b"]["compute_seconds_this_period"], 3700)
        self.assertEqual(tenants["c"]["compute_seconds_this_period"], 200)

    def test_meter_no_tenants(self):
        provisioner.write_tenants({})
        provisioner.UsageMeter()._meter()
        self.assertEqual(provisioner.read_tenants(), {})

    def test_meter_all_stopped(self):
        """All stopped → no writes, nothing changes."""
        provisioner.write_tenants({
            "x": {"status": "stopped", "compute_seconds_this_period": 999},
        })
        provisioner.UsageMeter()._meter()
        self.assertEqual(provisioner.read_tenants()["x"]["compute_seconds_this_period"], 999)

    def test_meter_missing_compute_field(self):
        """Tenant without compute_seconds defaults to 0."""
        provisioner.write_tenants({
            "nofield": {"status": "running"},
        })
        provisioner.UsageMeter()._meter()
        self.assertEqual(provisioner.read_tenants()["nofield"]["compute_seconds_this_period"], 3600)


# ===================================================================
# 11. Caddy route patching (3 tests)
# ===================================================================
class TestCaddyPatch(unittest.TestCase):

    @patch("urllib.request.urlopen")
    def test_patch_success(self, mock_urlopen):
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = resp
        result = provisioner.patch_caddy_route("tenant-alice", "127.0.0.1:9001")
        self.assertTrue(result)

    @patch("urllib.request.urlopen", side_effect=Exception("connection refused"))
    def test_patch_failure(self, mock_urlopen):
        result = provisioner.patch_caddy_route("tenant-alice", "127.0.0.1:9001")
        self.assertFalse(result)

    @patch("urllib.request.urlopen")
    def test_patch_sends_correct_data(self, mock_urlopen):
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = resp
        provisioner.patch_caddy_route("tenant-bob", "127.0.0.1:9002")
        req = mock_urlopen.call_args[0][0]
        self.assertIn("tenant-bob", req.full_url)
        self.assertEqual(req.method, "PATCH")
        sent_data = json.loads(req.data)
        self.assertEqual(sent_data, [{"dial": "127.0.0.1:9002"}])


# ===================================================================
# 12. Thread safety (2 tests)
# ===================================================================
class TestThreadSafety(unittest.TestCase):

    def setUp(self):
        provisioner.TENANT_FILE = TENANT_FILE
        provisioner.write_tenants({"shared": {"count": 0, "status": "running"}})

    def test_concurrent_updates(self):
        """Multiple threads updating different fields don't corrupt data."""
        errors = []

        def updater(field, value):
            try:
                for _ in range(20):
                    provisioner.update_tenant("shared", **{field: value})
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=updater, args=("field_a", "aaa")),
            threading.Thread(target=updater, args=("field_b", "bbb")),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        t = provisioner.read_tenants()["shared"]
        self.assertEqual(t["field_a"], "aaa")
        self.assertEqual(t["field_b"], "bbb")

    def test_concurrent_reads(self):
        """Concurrent reads don't error."""
        results = []

        def reader():
            for _ in range(50):
                results.append(provisioner.read_tenants())

        threads = [threading.Thread(target=reader) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(results), 200)
        self.assertTrue(all(isinstance(r, dict) for r in results))


# Cleanup
def tearDownModule():
    import shutil
    shutil.rmtree(TEST_DIR, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
