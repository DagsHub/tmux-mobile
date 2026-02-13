# tmux-mobile Security Architecture

This document describes the security model of `tmux-mobile` as it exists today, including what it protects well, what it does not protect well, and how to operate it safely.

It is intended to serve two audiences:
- maintainers changing authentication, transport, or command execution code
- prospective users evaluating whether the risk profile fits their use case

## Scope And Security Posture

`tmux-mobile` is a remote control surface for a live tmux session. Anyone who successfully authenticates can run commands as the same OS user that launched `tmux-mobile`.

Current posture:
- Good for trusted personal workflows and small-team use with careful sharing hygiene.
- Not a hardened multi-tenant remote access gateway.
- Relies on shared-secret authentication (URL token, optional password) rather than identity provider integration, device trust, or fine-grained authorization.

## Security Goals

- Prevent casual unauthorized access if a URL is guessed or seen.
- Keep default setup safer than "open shell on the internet" by requiring authentication.
- Avoid shell-command injection in backend tmux control paths.
- Keep auth state ephemeral across server restarts.

## Non-Goals

- Per-user accounts, RBAC, or scoped permissions.
- Zero-trust identity verification (OIDC/SAML/JWT).
- Formal brute-force defenses (rate limits, lockouts, IP reputation).
- Full audit trail and forensic-grade logging.

## System And Trust Boundaries

### Components

- Backend HTTP/WebSocket server: `src/backend/server.ts`
- Auth service: `src/backend/auth/auth-service.ts`
- CLI bootstrap and credential generation: `src/backend/cli.ts`
- Cloudflare quick tunnel process manager: `src/backend/cloudflared/manager.ts`
- Frontend client storing password and opening sockets: `src/frontend/App.tsx`
- tmux command executor: `src/backend/tmux/cli-executor.ts`
- PTY runtime bridging websocket I/O to tmux: `src/backend/pty/terminal-runtime.ts`

### Data Flows

1. CLI starts server on `127.0.0.1:<port>` (`src/backend/cli.ts`).
2. CLI generates startup token and (by default) a password if one is not supplied.
3. CLI prints:
   - local URL with `?token=...`
   - tunnel URL with `?token=...` (if tunnel enabled)
   - password separately (when password protection is enabled)
4. Browser loads app and opens two sockets:
   - `/ws/control` for JSON control/state
   - `/ws/terminal` for terminal stream
5. First message on each socket must be `{ type: "auth", token, password }`.
6. After auth success, client can fully control the tmux session and read terminal output.

## Authentication And Authorization

### Mechanism

- Token:
  - Generated with `crypto.randomBytes(...).toString("base64url")` (`src/backend/util/random.ts`).
  - Default token size: 18 bytes entropy (144 bits).
  - Always required by backend auth checks (`src/backend/auth/auth-service.ts`).
- Password:
  - Enabled by default (`--require-password` default true in `src/backend/cli.ts`).
  - If not provided, auto-generated with 16 random bytes (128 bits) (`src/backend/cli.ts`).
  - Verified as plain string equality in memory (`src/backend/auth/auth-service.ts`).

### Handshake Enforcement

- Control socket rejects non-auth first messages with `auth_error`.
- Terminal socket closes with code `4001` if first message is not valid auth.
- Each websocket connection authenticates independently (`src/backend/server.ts`).

### Authorization Model

- All-or-nothing.
- Once authenticated, client can issue all control operations and terminal input.
- No role separation (read-only vs control).

## Credential Lifecycle And Storage

### Server Side

- Token and password are in process memory only for the lifetime of the server process.
- Restarting server rotates token and auto-generated password.
- Credentials are not persisted in project config files.

### Client Side

- Password is stored in browser `localStorage` under `tmux-mobile-password` on successful auth when password is required (`src/frontend/App.tsx`).
- Saved password is removed on auth failures and when password protection is not required.
- Token is read from URL query string on page load (`src/frontend/App.tsx`).

Implication: browser compromise on that origin can expose saved password and URL token.

## Transport Security

### Local Mode

- Server binds to `127.0.0.1` by default (`src/backend/cli.ts`), limiting direct network exposure.
- If accessed over plain `http://`, websocket traffic uses `ws://` (`src/frontend/App.tsx`), so local network transport is not encrypted.

### Tunnel Mode

- With tunnel enabled, cloudflared publishes an HTTPS `*.trycloudflare.com` URL.
- Browser uses `wss://` because page protocol is HTTPS.
- Backend itself still serves local HTTP, with cloudflared proxying to localhost.
- Security of public access depends on both tmux-mobile secrets and Cloudflare tunnel behavior.

## Input Handling And Command Execution

### Positive Controls

- tmux control commands use `execFile` argument arrays, not shell interpolation (`src/backend/tmux/cli-executor.ts`).
- PTY attach commands quote session names when shell is used (`src/backend/pty/node-pty-adapter.ts`).
- Backend strips inherited `TMUX` and `TMUX_PANE` env vars for child processes (`src/backend/util/env.ts`).

### Current Gaps

- WebSocket message parser only checks "JSON object with string `type`" and does not fully validate message schema at runtime (`src/backend/server.ts`).
- No explicit message size limits or per-client command quotas.

## Logging And Diagnostics

- Optional file logging via `--debug-log` or `TMUX_MOBILE_DEBUG_LOG` (`src/backend/cli.ts`, `src/backend/util/file-logger.ts`).
- Logs include auth success/failure events and message types.
- Logs do not intentionally print token/password values from auth payloads.
- CLI output prints URLs (with token) and password to terminal at startup by design.

Operational implication: terminal scrollback, shell history captures, or screenshots can leak credentials.

## Supply Chain And Installer Risks

- Tunnel helper may auto-install `cloudflared`:
  - macOS: `brew install cloudflared`
  - Linux: download latest binary via `curl` and mark executable
  (`src/backend/cloudflared/manager.ts`)
- Current Linux path does not pin version or verify checksum/signature in project code.

If your environment has strict supply-chain requirements, pre-install and manage `cloudflared` externally, and/or run with `--no-tunnel`.

## Known Weaknesses (Current Implementation)

1. No brute-force throttling or lockout in auth service.
2. No websocket origin allowlist check on upgrade.
3. Token in URL query string can leak via browser history, copy/paste, logs, and screenshots.
4. Password saved in browser localStorage in plaintext.
5. Password verification uses plaintext equality in memory (acceptable for ephemeral runtime, but weaker than hashed-at-rest approaches if process memory is exposed).
6. No per-user identity or session revocation beyond restarting server.
7. Single trust domain: authenticated user gets full tmux control.
8. Local non-HTTPS mode can expose traffic to local network attackers.

## Recommended Operating Practices

1. Keep password protection enabled (default).
2. Prefer tunnel HTTPS URLs over exposing plain HTTP on shared networks.
3. Share token URL and password through separate channels.
4. Rotate quickly: stop/restart tmux-mobile after sharing incidents.
5. Avoid storing credentials in screenshots, chat logs, and shell logs.
6. Run under a dedicated low-privilege OS user where possible.
7. Use isolated tmux socket (`TMUX_MOBILE_SOCKET_NAME` or `TMUX_MOBILE_SOCKET_PATH`) for blast-radius control.
8. Disable tunnel (`--no-tunnel`) for local-only workflows.
9. Clear browser storage on shared/untrusted devices.
10. Keep dependencies and cloudflared updated.

## Objection Handling FAQ

### "If someone gets the URL, are we compromised?"

Not automatically if password is enabled. The URL token is required but not sufficient when password is required. If both leak, assume full compromise and rotate immediately by restarting tmux-mobile.

### "Is this safe for exposing production servers to the internet?"

It can be used cautiously for admin access, but it is not a full zero-trust access broker. Use it only when shared-secret access is acceptable and you can tolerate full-shell consequences of credential leakage.

### "Can attackers brute-force the password?"

There is no built-in throttling/lockout today. Strong random passwords and short session lifetime are important.

### "Does Cloudflare have to be trusted?"

Yes, in tunnel mode you trust Cloudflare and the local `cloudflared` agent path. If that trust is not acceptable, run local-only with your own transport/auth controls.

### "Can we give read-only access?"

No. Current model grants full control after auth.

### "Do you store secrets on disk?"

Server-side token/password are runtime memory only. Browser may persist password in localStorage for convenience.

## Maintenance Guide

When changing security-sensitive behavior, review and update this document and `README.md` "Security Defaults".

### Security-Sensitive Files

- `src/backend/auth/auth-service.ts`
- `src/backend/server.ts`
- `src/backend/cli.ts`
- `src/backend/cloudflared/manager.ts`
- `src/frontend/App.tsx`
- `src/backend/tmux/cli-executor.ts`
- `src/backend/pty/node-pty-adapter.ts`
- `src/backend/util/random.ts`

### Regression Tests To Keep Green

- `tests/integration/server.test.ts` (auth handshake and invalid token behavior)
- `tests/e2e/app.chrome.spec.ts` (password UX and retry flows)

### Change Checklist

1. Re-evaluate threat model assumptions in this document.
2. Verify auth handshake still gates both websockets.
3. Verify no credential logging was introduced.
4. Verify transport behavior (`ws`/`wss`) remains expected.
5. Add/adjust integration and e2e tests for auth and failure cases.
