# tmux-mobile

Implementation of `SPEC.md`: mobile-first tmux web client with a Node.js backend and React + xterm frontend.

## Quick Start

```bash
npm install
npm run build
node dist/backend/cli.js
```

Development mode:

```bash
npm run dev
```

Typecheck + tests + build:

```bash
npm run typecheck
npm test
npm run build
```

## CLI

```bash
tmux-mobile [options]

Options:
  -p, --port <port>      Local port (default: 8767)
  --password <pass>      Require password authentication
  --no-tunnel            Don't start cloudflared tunnel
  --session <name>       Default tmux session name (default: main)
  --scrollback <lines>   Default scrollback capture lines (default: 1000)
  --debug-log <path>     Write backend debug logs to a file
```

Optional environment variables:

- `TMUX_MOBILE_SOCKET_NAME`: Use a dedicated tmux socket name (`tmux -L`) for isolation
- `TMUX_MOBILE_SOCKET_PATH`: Use an explicit tmux socket path (`tmux -S`)
- `TMUX_MOBILE_DEBUG_LOG`: Alternative way to enable debug log file output
- `TMUX_MOBILE_FORCE_SCRIPT_PTY=1`: Force the Unix `script(1)` PTY fallback

## Test Harness

The suite uses deterministic fakes so behavior can be validated without real tmux/cloudflared/mobile interaction:

- `FakeTmuxGateway`: in-memory tmux session/window/pane state machine
- `FakePtyFactory`: captures terminal writes/resizes and emits PTY output
- Integration tests validate auth, attach flow, session picker, mutations, scrollback capture, and terminal I/O bridge

Run tests:

```bash
npm test
```

Browser E2E tests (Playwright + Chromium):

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

Real tmux smoke test (requires `tmux`):

```bash
npm run test:smoke
```

## GitHub Actions

- `CI` (`.github/workflows/ci.yml`)
  - Runs typecheck, tests, and build on push/PR
  - Runs browser E2E tests via Playwright Chromium
  - Runs an additional real tmux smoke job on Ubuntu with `tmux` installed
- `Publish` (`.github/workflows/publish.yml`)
  - Triggered manually or by GitHub Release publish
  - Runs tests + build, then publishes to npm using `NPM_TOKEN`

Repository secret required for publish workflow:

- `NPM_TOKEN`: npm automation token with publish rights for `tmux-mobile`
