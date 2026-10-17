"""Fleet values for the live voice tests: fleet.local.json at the repo root
(git-ignored; copy fleet.example.json). Keeps real phone numbers out of git.

Secrets come from the environment, or from 1Password via the `secrets`
section (notes holding KEY=value lines, read in memory with the op CLI).
"""
import json
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
_path = ROOT / "fleet.local.json"
if not _path.exists():
    sys.exit(f"{_path} is missing: copy fleet.example.json to it and fill in real values")
F = json.loads(_path.read_text())

HOST = F["otaconHost"]


def host_id(phone: str) -> str:
    return F["phones"][phone]["hostId"]


def number(phone: str) -> str:
    return F["phones"][phone]["number"]


def secret(name: str) -> str:
    """An API key: from the environment, else from 1Password."""
    if os.environ.get(name):
        return os.environ[name]
    s = F.get("secrets", {})
    ref = s.get(name)
    if not ref:
        sys.exit(f"{name} is not set and fleet.local.json has no secrets.{name}")
    env = dict(os.environ)
    with open(os.path.expanduser(s["opEnvFile"])) as f:
        for line in f:
            if line.startswith("OP_SERVICE_ACCOUNT_TOKEN="):
                env["OP_SERVICE_ACCOUNT_TOKEN"] = line.split("=", 1)[1].strip().strip('"')
    out = subprocess.run(["op", "item", "get", ref["item"], "--vault", s["opVault"], "--format", "json"],
                         capture_output=True, text=True, env=env, timeout=60)
    if out.returncode != 0:
        sys.exit(f"op: could not read the note for {name}")
    note = next(f["value"] for f in json.loads(out.stdout)["fields"] if f.get("label") == "notesPlain")
    m = re.search(rf"^\s*(?:export\s+)?{re.escape(ref['key'])}\s*=\s*[\"']?([^\"'\s]+)", note, re.M)
    if not m:
        sys.exit(f"the 1Password note has no {ref['key']}")
    return m.group(1)


if __name__ == "__main__":
    # `python fleet.py secret NAME` prints a secret for shell scripts (to a
    # pipe or variable, never a file); `python fleet.py get a.b.c` prints a value.
    if sys.argv[1:2] == ["secret"]:
        print(secret(sys.argv[2]))
    elif sys.argv[1:2] == ["get"]:
        v = F
        for k in sys.argv[2].split("."):
            v = v[k]
        print(v if isinstance(v, str) else json.dumps(v))
