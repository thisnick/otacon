# @otacon-fleet/otacon-cli

`otacon`: command-line client for [otacon](https://github.com/thisnick/otacon),
a fleet of Android phones driven from a Raspberry Pi. It talks to the fleet
registry and to each host: screenshots and UI snapshots, taps and typing, apps,
SMS, calls (dial, answer, hold, swap, merge, DTMF, listen), SIMs and eSIMs,
APNs, Wi-Fi, dongles.

```sh
npm install -g @otacon-fleet/otacon-cli
otacon auth register --registry http://<registry>:9080   # waits for an admin to approve
otacon phones list
otacon screenshot --phone phone-2 -o screen.png
otacon call dial +15555550100 --phone phone-2
```

Config (registry URL, token) lives in `~/.otacon/config.toml`; every value can
be overridden with an `OTACON_*` environment variable. Hosts are reached over Tailscale with TLS
verified; `OTACON_INSECURE_TLS=1` accepts a self-signed host certificate.

Requires Node.js 22 or later. See `skills/otacon-cli/SKILL.md` in the repo for
the full command reference.
