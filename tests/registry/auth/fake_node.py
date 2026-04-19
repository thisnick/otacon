#!/usr/bin/env python3
"""Fake fleet-node client for auth integration testing.

Simulates a fresh Pi node going through the full registration -> approval ->
authenticated-API-call lifecycle against the otacon-registry and otacon-admin
services.

Usage:
    python3 fake_node.py --registry-url http://otacon-registry...:9080 \
                         --admin-url http://otacon-admin...:9090

    # Run specific test phases:
    python3 fake_node.py --registry-url ... --admin-url ... --phase register
    python3 fake_node.py --registry-url ... --admin-url ... --phase full

Exit codes:
    0 = all tests passed
    1 = test failure (observable behavior mismatch)
    2 = infrastructure error (network, bad args, etc.)
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import requests
import websocket

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("fake_node")


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class TestResult:
    name: str
    passed: bool
    detail: str = ""

    def __str__(self):
        status = "PASS" if self.passed else "FAIL"
        s = f"  [{status}] {self.name}"
        if self.detail:
            s += f" -- {self.detail}"
        return s


@dataclass
class NodeIdentity:
    host_id: str = field(default_factory=lambda: f"fake-test-node-{uuid.uuid4()}")
    pending_id: Optional[str] = None
    token: Optional[str] = None
    token_id: Optional[str] = None


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def api_post(url: str, body: dict, token: Optional[str] = None,
             expected_status: Optional[int] = None,
             timeout: int = 30) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.post(url, json=body, headers=headers, timeout=timeout)
    if expected_status is not None and resp.status_code != expected_status:
        log.warning(
            "Expected %d from POST %s, got %d: %s",
            expected_status, url, resp.status_code, resp.text[:200],
        )
    return resp


def api_get(url: str, token: Optional[str] = None,
            expected_status: Optional[int] = None,
            timeout: int = 30) -> requests.Response:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.get(url, headers=headers, timeout=timeout)
    if expected_status is not None and resp.status_code != expected_status:
        log.warning(
            "Expected %d from GET %s, got %d: %s",
            expected_status, url, resp.status_code, resp.text[:200],
        )
    return resp


def api_delete(url: str, token: Optional[str] = None,
               expected_status: Optional[int] = None) -> requests.Response:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.delete(url, headers=headers, timeout=30)
    if expected_status is not None and resp.status_code != expected_status:
        log.warning(
            "Expected %d from DELETE %s, got %d: %s",
            expected_status, url, resp.status_code, resp.text[:200],
        )
    return resp


# ---------------------------------------------------------------------------
# Core registration flow
# ---------------------------------------------------------------------------

def register_node(registry_url: str, node: NodeIdentity) -> bool:
    """POST /api/v1/auth/register -> capture pending_id."""
    log.info("Registering node %s ...", node.host_id)
    resp = api_post(
        f"{registry_url}/api/v1/auth/register",
        {"host_id": node.host_id},
    )
    if resp.status_code not in (200, 201):
        log.error("Registration failed: %d %s", resp.status_code, resp.text[:200])
        return False
    data = resp.json()
    node.pending_id = data.get("pending_id") or data.get("id")
    if not node.pending_id:
        log.error("No pending_id in response: %s", data)
        return False
    log.info("Got pending_id=%s", node.pending_id)
    return True


def poll_for_token(registry_url: str, node: NodeIdentity,
                   timeout: int = 60) -> bool:
    """POST /api/v1/auth/poll/{pending_id} -- long-poll for approval."""
    log.info("Long-polling for approval (timeout=%ds) ...", timeout)
    try:
        resp = api_post(
            f"{registry_url}/api/v1/auth/poll/{node.pending_id}",
            {},
            timeout=timeout,
        )
    except requests.Timeout:
        log.warning("Poll timed out after %ds (client-side)", timeout)
        return False

    if resp.status_code == 200:
        data = resp.json()
        node.token = data.get("token")
        if node.token:
            log.info("Received token (prefix=%s...)", node.token[:20])
            return True
        log.error("200 but no token in response: %s", data)
        return False
    elif resp.status_code == 403:
        log.info("Registration was rejected (403)")
        return False
    elif resp.status_code == 408:
        log.info("Poll timed out server-side (408)")
        return False
    else:
        log.error("Unexpected poll response: %d %s", resp.status_code, resp.text[:200])
        return False


def admin_approve(admin_url: str, pending_id: str,
                  admin_token: str) -> bool:
    """POST /api/v1/auth/registrations/{id}/approve via admin service."""
    log.info("Admin approving registration %s ...", pending_id)
    resp = api_post(
        f"{admin_url}/api/v1/auth/registrations/{pending_id}/approve",
        {},
        token=admin_token,
    )
    if resp.status_code not in (200, 201):
        log.error("Admin approve failed: %d %s", resp.status_code, resp.text[:200])
        return False
    log.info("Admin approved registration %s", pending_id)
    return True


def admin_reject(admin_url: str, pending_id: str,
                 admin_token: str) -> bool:
    """POST /api/v1/auth/registrations/{id}/reject via admin service."""
    log.info("Admin rejecting registration %s ...", pending_id)
    resp = api_post(
        f"{admin_url}/api/v1/auth/registrations/{pending_id}/reject",
        {},
        token=admin_token,
    )
    if resp.status_code not in (200, 201):
        log.error("Admin reject failed: %d %s", resp.status_code, resp.text[:200])
        return False
    log.info("Admin rejected registration %s", pending_id)
    return True


def find_token_id(admin_url: str, raw_token: str,
                   admin_token: str) -> Optional[str]:
    """Find a token's ID by matching its prefix in the admin token list."""
    prefix = raw_token[:12]
    tokens = admin_list_tokens(admin_url, admin_token)
    if not tokens:
        return None
    for t in tokens:
        if t.get("token_prefix") == prefix:
            return t.get("id")
    return None


def admin_revoke_token(admin_url: str, token_id: str,
                       admin_token: str) -> bool:
    """Revoke a token via admin service (POST .../revoke)."""
    log.info("Admin revoking token %s ...", token_id)
    resp = api_post(
        f"{admin_url}/api/v1/auth/tokens/{token_id}/revoke",
        {},
        token=admin_token,
    )
    if resp.status_code == 200:
        log.info("Token %s revoked", token_id)
        return True
    log.error("Token revoke failed: %d %s", resp.status_code, resp.text[:200])
    return False


def admin_list_tokens(admin_url: str, admin_token: str) -> Optional[list]:
    """GET /api/v1/auth/tokens -- list all tokens (admin-scoped)."""
    resp = api_get(f"{admin_url}/api/v1/auth/tokens", token=admin_token)
    if resp.status_code == 200:
        return resp.json()
    log.warning("List tokens returned %d", resp.status_code)
    return None


def admin_list_registrations(admin_url: str, admin_token: str) -> Optional[list]:
    """GET /api/v1/auth/registrations/pending -- list pending registrations."""
    resp = api_get(f"{admin_url}/api/v1/auth/registrations/pending", token=admin_token)
    if resp.status_code == 200:
        return resp.json()
    log.warning("List registrations returned %d", resp.status_code)
    return None


# ---------------------------------------------------------------------------
# Authenticated node API calls
# ---------------------------------------------------------------------------

def node_heartbeat(registry_url: str, node: NodeIdentity) -> requests.Response:
    """POST /api/v1/hosts/heartbeat as an authenticated node."""
    return api_post(
        f"{registry_url}/api/v1/hosts/heartbeat",
        {"host_id": node.host_id, "phones": [], "dongles": []},
        token=node.token,
    )


def node_register_host(registry_url: str, node: NodeIdentity) -> requests.Response:
    """POST /api/v1/hosts/register as an authenticated node."""
    return api_post(
        f"{registry_url}/api/v1/hosts/register",
        {"id": node.host_id},
        token=node.token,
    )


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

def cleanup_node(registry_url: str, admin_url: str, node: NodeIdentity,
                 admin_token: str):
    """Best-effort cleanup of test registration + token."""
    if node.token and admin_token:
        try:
            tid = node.token_id or find_token_id(admin_url, node.token, admin_token)
            if tid:
                admin_revoke_token(admin_url, tid, admin_token)
        except Exception as e:
            log.warning("Cleanup revoke failed: %s", e)

    # Clean up the host entry we may have created
    if node.token:
        try:
            api_delete(
                f"{registry_url}/api/v1/hosts/{node.host_id}",
                token=node.token,
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Full registration flow test
# ---------------------------------------------------------------------------

def test_full_registration(registry_url: str, admin_url: str,
                           admin_token: str) -> list[TestResult]:
    """Full lifecycle: register -> approve -> use token -> revoke -> 401."""
    results = []
    node = NodeIdentity()

    try:
        # Step 1: Register
        ok = register_node(registry_url, node)
        results.append(TestResult("register_node", ok,
                                  f"pending_id={node.pending_id}"))
        if not ok:
            return results

        # Step 2: Poll + approve in parallel
        poll_result = {"done": False, "ok": False}

        def poll_thread():
            poll_result["ok"] = poll_for_token(registry_url, node, timeout=30)
            poll_result["done"] = True

        t = threading.Thread(target=poll_thread, daemon=True)
        t.start()

        # Give poll a moment to establish connection
        time.sleep(1)

        # Step 3: Admin approves
        ok = admin_approve(admin_url, node.pending_id, admin_token)
        results.append(TestResult("admin_approve", ok))
        if not ok:
            return results

        # Wait for poll to complete
        t.join(timeout=15)
        results.append(TestResult("poll_receives_token", poll_result["ok"],
                                  f"token_prefix={node.token[:20] if node.token else 'none'}"))
        if not poll_result["ok"]:
            return results

        # Step 4: Use token for heartbeat
        resp = node_heartbeat(registry_url, node)
        results.append(TestResult("heartbeat_with_token",
                                  resp.status_code == 200,
                                  f"status={resp.status_code}"))

        # Step 5: Find token_id and revoke
        token_id = find_token_id(admin_url, node.token, admin_token)
        if token_id:
            node.token_id = token_id
            ok = admin_revoke_token(admin_url, token_id, admin_token)
            results.append(TestResult("revoke_token", ok))

            # Step 6: Use revoked token -> expect 401
            resp = node_heartbeat(registry_url, node)
            results.append(TestResult("revoked_token_rejected",
                                      resp.status_code == 401,
                                      f"status={resp.status_code}"))
        else:
            results.append(TestResult("revoke_token", False,
                                      "could not find token_id via admin API"))

    finally:
        cleanup_node(registry_url, admin_url, node, admin_token)

    return results


# ---------------------------------------------------------------------------
# Scope enforcement tests
# ---------------------------------------------------------------------------

def test_node_token_cant_call_admin(registry_url: str, admin_url: str,
                                    admin_token: str) -> list[TestResult]:
    """Node token must NOT be able to hit admin-scoped endpoints."""
    results = []
    node = NodeIdentity()

    try:
        # Get a valid node token first
        if not register_node(registry_url, node):
            return [TestResult("setup_register", False)]

        poll_done = threading.Event()
        poll_ok = [False]

        def poll():
            poll_ok[0] = poll_for_token(registry_url, node, timeout=30)
            poll_done.set()

        t = threading.Thread(target=poll, daemon=True)
        t.start()
        time.sleep(1)
        admin_approve(admin_url, node.pending_id, admin_token)
        poll_done.wait(timeout=15)

        if not poll_ok[0] or not node.token:
            return [TestResult("setup_get_token", False)]

        # Try admin endpoints with node token
        # 1. Approve endpoint
        resp = api_post(
            f"{admin_url}/api/v1/auth/registrations/fake-id/approve",
            {},
            token=node.token,
        )
        results.append(TestResult(
            "node_token_approve_blocked",
            resp.status_code == 403,
            f"status={resp.status_code} body={resp.text[:100]}",
        ))

        # 2. List tokens
        resp = api_get(f"{admin_url}/api/v1/auth/tokens", token=node.token)
        results.append(TestResult(
            "node_token_list_tokens_blocked",
            resp.status_code == 403,
            f"status={resp.status_code}",
        ))

        # 3. Events WebSocket (if admin-scoped)
        resp = api_get(f"{admin_url}/ws/fleet/events", token=node.token)
        # WS upgrade with wrong scope should fail
        results.append(TestResult(
            "node_token_events_ws_blocked",
            resp.status_code in (403, 401),
            f"status={resp.status_code}",
        ))

    finally:
        cleanup_node(registry_url, admin_url, node, admin_token)

    return results


def test_admin_token_cant_call_node(registry_url: str, admin_url: str,
                                     admin_token: str) -> list[TestResult]:
    """Admin token should NOT be usable for node-scoped endpoints on registry."""
    results = []

    # Try heartbeat with admin token on registry
    resp = api_post(
        f"{registry_url}/api/v1/hosts/heartbeat",
        {"host_id": "admin-impersonation-test", "phones": [], "dongles": []},
        token=admin_token,
    )
    # Should be 403 if strict scope enforcement
    results.append(TestResult(
        "admin_token_heartbeat_blocked",
        resp.status_code == 403,
        f"status={resp.status_code} body={resp.text[:100]}",
    ))

    # Try host register with admin token on registry
    resp = api_post(
        f"{registry_url}/api/v1/hosts/register",
        {"id": "admin-impersonation-test"},
        token=admin_token,
    )
    results.append(TestResult(
        "admin_token_host_register_blocked",
        resp.status_code == 403,
        f"status={resp.status_code}",
    ))

    return results


def test_no_auth_rejected(registry_url: str) -> list[TestResult]:
    """Request with no Auth header -> 401."""
    results = []

    resp = api_post(
        f"{registry_url}/api/v1/hosts/heartbeat",
        {"host_id": "no-auth-test", "phones": [], "dongles": []},
    )
    results.append(TestResult(
        "no_auth_heartbeat",
        resp.status_code == 401,
        f"status={resp.status_code}",
    ))

    resp = api_get(f"{registry_url}/api/v1/hosts")
    results.append(TestResult(
        "no_auth_list_hosts",
        resp.status_code == 401,
        f"status={resp.status_code}",
    ))

    return results


def test_invalid_token_rejected(registry_url: str) -> list[TestResult]:
    """Bogus bearer token -> 401."""
    results = []

    bogus_tokens = [
        "otc_node_garbage123",
        "otc_admin_garbage456",
        "not-even-a-token",
        "",
        "Bearer inception",  # nested bearer
    ]

    for bogus in bogus_tokens:
        resp = api_post(
            f"{registry_url}/api/v1/hosts/heartbeat",
            {"host_id": "bogus-test", "phones": [], "dongles": []},
            token=bogus,
        )
        label = bogus[:30] if bogus else "(empty)"
        results.append(TestResult(
            f"invalid_token_{label}",
            resp.status_code == 401,
            f"status={resp.status_code}",
        ))

    return results


def test_revoked_token_rejected(registry_url: str, admin_url: str,
                                 admin_token: str) -> list[TestResult]:
    """Revoke a token, then immediately use it -> 401."""
    results = []
    node = NodeIdentity()

    try:
        # Get a valid token
        if not register_node(registry_url, node):
            return [TestResult("setup_register", False)]

        poll_done = threading.Event()
        poll_ok = [False]

        def poll():
            poll_ok[0] = poll_for_token(registry_url, node, timeout=30)
            poll_done.set()

        t = threading.Thread(target=poll, daemon=True)
        t.start()
        time.sleep(1)
        admin_approve(admin_url, node.pending_id, admin_token)
        poll_done.wait(timeout=15)

        if not poll_ok[0] or not node.token:
            return [TestResult("setup_get_token", False)]

        # Confirm it works first
        resp = node_heartbeat(registry_url, node)
        results.append(TestResult("token_works_before_revoke",
                                  resp.status_code == 200,
                                  f"status={resp.status_code}"))

        # Find token_id and revoke
        token_id = find_token_id(admin_url, node.token, admin_token)
        if token_id:
            node.token_id = token_id
            admin_revoke_token(admin_url, token_id, admin_token)
        else:
            results.append(TestResult("revoke_setup", False, "could not find token_id"))
            return results

        # Immediately use revoked token
        resp = node_heartbeat(registry_url, node)
        results.append(TestResult("revoked_token_immediate_401",
                                  resp.status_code == 401,
                                  f"status={resp.status_code}"))

    finally:
        cleanup_node(registry_url, admin_url, node, admin_token)

    return results


# ---------------------------------------------------------------------------
# Long-poll edge cases
# ---------------------------------------------------------------------------

def test_long_poll_timeout(registry_url: str) -> list[TestResult]:
    """Register, never approve, verify long-poll returns 408."""
    results = []
    node = NodeIdentity()

    if not register_node(registry_url, node):
        return [TestResult("register", False)]

    log.info("Waiting for long-poll timeout (this may take a while) ...")
    try:
        resp = api_post(
            f"{registry_url}/api/v1/auth/poll/{node.pending_id}",
            {},
            timeout=120,  # give generous client timeout
        )
        results.append(TestResult(
            "poll_timeout_408",
            resp.status_code == 408,
            f"status={resp.status_code}",
        ))
    except requests.Timeout:
        results.append(TestResult(
            "poll_timeout_408",
            False,
            "Client timed out before server returned 408 — server may not enforce timeout",
        ))

    return results


def test_long_poll_rejection(registry_url: str, admin_url: str,
                              admin_token: str) -> list[TestResult]:
    """Register, admin rejects, verify long-poll returns 403."""
    results = []
    node = NodeIdentity()

    if not register_node(registry_url, node):
        return [TestResult("register", False)]

    poll_result = {"status": None, "done": False}

    def poll():
        try:
            resp = api_post(
                f"{registry_url}/api/v1/auth/poll/{node.pending_id}",
                {},
                timeout=30,
            )
            poll_result["status"] = resp.status_code
        except Exception as e:
            poll_result["status"] = f"error: {e}"
        poll_result["done"] = True

    t = threading.Thread(target=poll, daemon=True)
    t.start()
    time.sleep(1)

    # Admin rejects
    admin_reject(admin_url, node.pending_id, admin_token)

    t.join(timeout=15)
    results.append(TestResult(
        "poll_rejection_403",
        poll_result["status"] == 403,
        f"status={poll_result['status']}",
    ))

    return results


# ---------------------------------------------------------------------------
# Concurrent registrations
# ---------------------------------------------------------------------------

def test_concurrent_registrations(registry_url: str, admin_url: str,
                                   admin_token: str) -> list[TestResult]:
    """Fire 5 register calls in parallel, approve all, verify unique tokens."""
    results = []
    nodes = [NodeIdentity() for _ in range(5)]
    tokens_received = []

    try:
        # Register all in parallel
        threads = []
        register_ok = [False] * 5

        def do_register(idx, n):
            register_ok[idx] = register_node(registry_url, n)

        for i, n in enumerate(nodes):
            t = threading.Thread(target=do_register, args=(i, n))
            threads.append(t)
            t.start()

        for t in threads:
            t.join(timeout=10)

        all_registered = all(register_ok)
        results.append(TestResult("all_5_registered", all_registered,
                                  f"ok={register_ok}"))
        if not all_registered:
            return results

        # Start polls for all
        poll_threads = []
        poll_ok = [False] * 5

        def do_poll(idx, n):
            poll_ok[idx] = poll_for_token(registry_url, n, timeout=30)

        for i, n in enumerate(nodes):
            t = threading.Thread(target=do_poll, args=(i, n))
            poll_threads.append(t)
            t.start()

        time.sleep(1)

        # Approve all
        for n in nodes:
            admin_approve(admin_url, n.pending_id, admin_token)

        for t in poll_threads:
            t.join(timeout=15)

        all_polled = all(poll_ok)
        results.append(TestResult("all_5_tokens_received", all_polled,
                                  f"ok={poll_ok}"))

        # Check uniqueness
        tokens = [n.token for n in nodes if n.token]
        unique_tokens = set(tokens)
        results.append(TestResult("all_tokens_unique",
                                  len(unique_tokens) == 5,
                                  f"got {len(unique_tokens)} unique out of {len(tokens)}"))

    finally:
        for n in nodes:
            cleanup_node(registry_url, admin_url, n, admin_token)

    return results


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

ALL_TESTS = {
    "full_registration": lambda r, a, t: test_full_registration(r, a, t),
    "node_cant_admin": lambda r, a, t: test_node_token_cant_call_admin(r, a, t),
    "admin_cant_node": lambda r, a, t: test_admin_token_cant_call_node(r, a, t),
    "no_auth": lambda r, a, t: test_no_auth_rejected(r),
    "invalid_token": lambda r, a, t: test_invalid_token_rejected(r),
    "revoked_token": lambda r, a, t: test_revoked_token_rejected(r, a, t),
    "poll_timeout": lambda r, a, t: test_long_poll_timeout(r),
    "poll_rejection": lambda r, a, t: test_long_poll_rejection(r, a, t),
    "concurrent": lambda r, a, t: test_concurrent_registrations(r, a, t),
}


def run_tests(registry_url: str, admin_url: str, admin_token: str,
              tests: Optional[list[str]] = None) -> bool:
    """Run specified tests (or all). Returns True if all pass."""
    test_map = ALL_TESTS
    if tests:
        test_map = {k: v for k, v in ALL_TESTS.items() if k in tests}

    all_results = []
    overall_pass = True

    for name, fn in test_map.items():
        print(f"\n{'='*60}")
        print(f"TEST: {name}")
        print(f"{'='*60}")
        try:
            results = fn(registry_url, admin_url, admin_token)
        except Exception as e:
            results = [TestResult(name, False, f"EXCEPTION: {e}")]

        for r in results:
            print(r)
            if not r.passed:
                overall_pass = False
        all_results.extend(results)

    # Summary
    passed = sum(1 for r in all_results if r.passed)
    failed = sum(1 for r in all_results if not r.passed)
    print(f"\n{'='*60}")
    print(f"SUMMARY: {passed} passed, {failed} failed, {len(all_results)} total")
    print(f"{'='*60}")

    return overall_pass


def main():
    parser = argparse.ArgumentParser(description="Fake fleet-node auth test client")
    parser.add_argument("--registry-url", required=True,
                        help="Registry service URL (e.g., http://otacon-registry...:9080)")
    parser.add_argument("--admin-url", required=True,
                        help="Admin service URL (e.g., http://otacon-admin...:9090)")
    parser.add_argument("--admin-token", default=None,
                        help="Admin bearer token (or set OTACON_ADMIN_TOKEN env var)")
    parser.add_argument("--test", action="append", dest="tests",
                        help="Run specific test(s) by name. Repeat for multiple.")
    parser.add_argument("--list-tests", action="store_true",
                        help="List available test names and exit")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Enable debug logging")

    args = parser.parse_args()

    if args.list_tests:
        for name in ALL_TESTS:
            print(f"  {name}")
        sys.exit(0)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    admin_token = args.admin_token or os.environ.get("OTACON_ADMIN_TOKEN")
    if not admin_token:
        log.error("No admin token provided. Use --admin-token or OTACON_ADMIN_TOKEN env var.")
        sys.exit(2)

    # Verify connectivity
    try:
        resp = requests.get(f"{args.registry_url}/", timeout=5)
        log.info("Registry reachable: %d", resp.status_code)
    except Exception as e:
        log.error("Cannot reach registry at %s: %s", args.registry_url, e)
        sys.exit(2)

    try:
        resp = requests.get(f"{args.admin_url}/", timeout=5)
        log.info("Admin reachable: %d", resp.status_code)
    except Exception as e:
        log.error("Cannot reach admin at %s: %s", args.admin_url, e)
        sys.exit(2)

    ok = run_tests(args.registry_url, args.admin_url, admin_token, args.tests)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
