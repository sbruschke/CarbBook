#!/usr/bin/env python3
"""Show, add or remove the recipes.dxshdw.dev route on Cloudflare tunnel `pi`.

  cloudflare-route.py show
  cloudflare-route.py add [--apply]      # dry run unless --apply
  cloudflare-route.py remove [--apply]

Only touches the one ingress rule (inserted just before the catch-all) and the one CNAME.
The API token is read from a Claude session log and is never printed.
"""
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN_FILE = Path.home() / ".claude/projects/-home-shadow-linux/1dc9e5ca-f3e6-4d3e-b8ac-7cfd09fe7f53.jsonl"
TOKEN_RE = re.compile(r"T='([A-Za-z0-9._-]{30,})'")
TOKEN_SHA256_PREFIX = "f4ea8121"
ACCOUNT = "ff4fdd9b459736d57f017e6645225586"
TUNNEL = "fdb3aebf-bc6c-48e1-bdf7-133261a745c0"
ZONE = "ed198a1135f51217415ceb107db532f3"
ZONE_NAME = "dxshdw.dev"
HOST = "recipes.dxshdw.dev"
SERVICE = "http://carbs-server:3000"
API = "https://api.cloudflare.com/client/v4"
_TOKEN = None


def token() -> str:
    global _TOKEN
    if _TOKEN is None:
        matches = sorted(set(TOKEN_RE.findall(TOKEN_FILE.read_text(errors="replace"))))
        matches = [m for m in matches if hashlib.sha256(m.encode()).hexdigest().startswith(TOKEN_SHA256_PREFIX)]
        if len(matches) != 1:
            sys.exit(f"expected exactly 1 token with sha256 prefix {TOKEN_SHA256_PREFIX} in {TOKEN_FILE.name}, found {len(matches)}")
        _TOKEN = matches[0]
    return _TOKEN


def call(method: str, path: str, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        data = json.load(err)
    if not data.get("success"):
        sys.exit(f"{method} {path} failed: {data.get('errors')}")
    return data["result"]


def get_config():
    return call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel/{TUNNEL}/configurations")["config"]


def ingress_lines(config):
    return [f"  {r.get('hostname', '*')} -> {r['service']}" for r in config["ingress"]]


def dns_records():
    return call("GET", f"/zones/{ZONE}/dns_records?name={HOST}")


def show():
    zone = call("GET", f"/zones/{ZONE}")
    if zone["name"] != ZONE_NAME:
        sys.exit(f"zone id is {zone['name']}, expected {ZONE_NAME}")
    print("ingress:")
    print("\n".join(ingress_lines(get_config())))
    recs = dns_records()
    print("dns:", [f"{r['type']} {r['name']} -> {r['content']} proxied={r['proxied']}" for r in recs] or "none")


def check_catch_all(ingress):
    if not ingress or "hostname" in ingress[-1] or ingress[-1]["service"] != "http_status:404":
        sys.exit("last ingress rule is not the http_status:404 catch-all; refusing to edit")


def add(apply: bool):
    config = get_config()
    ingress = config["ingress"]
    check_catch_all(ingress)
    existing = [r for r in ingress if r.get("hostname") == HOST]
    if existing and existing[0]["service"] != SERVICE:
        sys.exit(f"{HOST} already routed to {existing[0]['service']}; refusing to change it")
    if not existing:
        config["ingress"] = ingress[:-1] + [{"hostname": HOST, "service": SERVICE, "originRequest": {}}] + ingress[-1:]
    print("ingress after:")
    print("\n".join(ingress_lines(config)))

    recs = dns_records()
    target = f"{TUNNEL}.cfargotunnel.com"
    if recs and not (len(recs) == 1 and recs[0]["type"] == "CNAME" and recs[0]["content"] == target and recs[0]["proxied"]):
        sys.exit(f"unexpected existing DNS records for {HOST}: {[(r['type'], r['content']) for r in recs]}")
    print("dns:", "already correct" if recs else f"create CNAME {HOST} -> {target} proxied")

    if not apply:
        print("dry run; re-run with --apply")
        return
    if not existing:
        call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{TUNNEL}/configurations", {"config": config})
    if not recs:
        call("POST", f"/zones/{ZONE}/dns_records",
             {"type": "CNAME", "name": HOST, "content": target, "proxied": True, "comment": "CarbBook via tunnel pi"})
    print("applied; now:")
    show()


def remove(apply: bool):
    config = get_config()
    check_catch_all(config["ingress"])
    config["ingress"] = [r for r in config["ingress"] if r.get("hostname") != HOST]
    print("ingress after:")
    print("\n".join(ingress_lines(config)))
    target = f"{TUNNEL}.cfargotunnel.com"
    recs = [r for r in dns_records() if r["type"] == "CNAME" and r["content"] == target]
    print("dns: delete", [r["name"] for r in recs] or "nothing")
    if not apply:
        print("dry run; re-run with --apply")
        return
    call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{TUNNEL}/configurations", {"config": config})
    for r in recs:
        call("DELETE", f"/zones/{ZONE}/dns_records/{r['id']}")
    print("removed; now:")
    show()


if __name__ == "__main__":
    args = sys.argv[1:]
    apply = "--apply" in args
    cmd = next((a for a in args if not a.startswith("--")), "show")
    {"show": show, "add": lambda: add(apply), "remove": lambda: remove(apply)}.get(cmd, lambda: sys.exit(__doc__))()
