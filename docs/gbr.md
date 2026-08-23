# Phone spectator with Build Remote Agent

tmux-mobile is a mobile-first web UI for tmux. By default it can start a
**cloudflared tunnel** and print a QR so a phone browser can drive the session.

If you only need a **phone to watch / veto** a desktop coding-agent tmux
session, you do not need a public tunnel URL.

**Build Remote Agent** is a companion pairing device, not a tmux-mobile
replacement. Keep `tmux-mobile --no-tunnel` (or skip the web UI). The phone
spectates through free MIT `gbr-agent` on loopback. Phone and PC never open
ports to each other.

Website: https://grokbuildremote.com/
Agent: https://github.com/LinespottingOrg/GrokBuildRemote-Agents (MIT)
Protocol: `gbr/1` · need agent **v0.6.0+**

Not affiliated with xAI or SpaceX.

## When to use which

| Goal | Path |
|------|------|
| Touch tmux UI in the phone browser | `npx tmux-mobile` (local URL or cloudflared QR) |
| Spectator / veto only, no inbound, no tunnel | `tmux-mobile --no-tunnel` plus this page |

## Install + pair

```bash
# macOS / Linux
curl -fsSL https://grokbuildremote.com/install.sh | bash
gbr-agent version          # must print v0.6.0 or newer
gbr-agent pair             # QR in browser + printed 8-char code
gbr-agent run              # leave running
```

```powershell
# Windows
irm https://grokbuildremote.com/install.ps1 | iex
gbr-agent version
gbr-agent pair
gbr-agent run
```

Optional: keep the local tmux-mobile UI without a tunnel:

```bash
npx tmux-mobile --no-tunnel
```

Phone: open Build Remote Agent → **Scan QR from computer** (or type the 8-char
code). Sessions appear in the app. **Unpair** in Settings before changing PCs.
Force-close is not enough.

## Attach

After `gbr-agent run`:

- HTTP Bot API: `http://127.0.0.1:8788`
- MCP stdio: clone the agent repo and run `node mcp/gbr-mcp/bin/gbr-mcp.js`

```bash
curl -sS http://127.0.0.1:8788/health
curl -sS http://127.0.0.1:8788/v1/sessions
```

Phone is spectator. Orchestration stays on this desktop (tmux / Claude Code,
or a Grok bot / Claude Cowork talking to the same Bot API).

Do not commit mailbox keys. Phone **Settings → Bot API** is the only place the
relay key is copied.
