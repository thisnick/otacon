# @otacon-fleet/otacon-cli

## 0.3.0

### Minor Changes

- 1f06f83: `otacon link <host> <phone>` links the CLI straight to one phone on an otacon host, saved in `~/.otacon/config.toml` (no registry needed); `otacon link` shows it and `otacon unlink` removes it. `otacon auth whoami` shows the link.

## 0.2.0

First release on npm (previously installed from the repo as `otacon-cli`).

- Calls over the new voice API: `otacon call status` lists every call;
  `reject`, `hold`, `resume`, `swap`, `merge`, `dtmf <digits>`,
  `hangup --call <id>`; `otacon call listen [--out file.wav]` plays or records
  both sides of a call.
- TLS is verified; `OTACON_INSECURE_TLS=1` accepts a self-signed host
  certificate.
