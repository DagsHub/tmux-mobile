# tmux-mobile Specification

## Overview

A mobile-first web app that provides an opinionated tmux interface via cloudflared tunnel. Unlike generic web terminals (e.g., porterminal), tmux-mobile is purpose-built for tmux: it always runs inside a tmux session and provides touch-friendly UI for tmux operations that are painful on mobile keyboards (window/pane switching, copy mode, split, etc.).

**Distribution:** npm package, invoked via `npx tmux-mobile`
**Tech Stack:** Node.js backend (Express + node-pty + WebSocket), React frontend (Vite + xterm.js)
**Reference:** ./porterminal - clone from https://github.com/lyehe/porterminal (submodule) - the original inspiration for this repo. The difference is that porterminal offers a generic shell session, and this project aims to offer a first class web mobile experience for tmux specifically.

---

## Architecture

### Backend (Node.js)

- **Express** HTTP server serving the React frontend as static files
- **node-pty** to spawn and manage the tmux PTY process
- **ws** (or Express-ws) for WebSocket connections
- Two WebSocket channels:
  - **Data plane** (`/ws/terminal`): Binary terminal I/O between xterm.js and the tmux PTY
  - **Control plane** (`/ws/control`): JSON messages for tmux state, commands, auth
- **tmux CLI executor**: Runs `tmux` commands server-side (e.g., `tmux list-windows`, `tmux split-window`) and returns structured output
- **tmux state monitor**: Event-driven monitoring of tmux state changes via periodic polling (every 2-3s) of `tmux list-sessions/windows/panes`, with change detection to only push updates when state changes
- **Cloudflared manager**: Starts/stops a cloudflared quick tunnel, extracts and displays the public URL + QR code in the terminal

### Frontend (React + TypeScript)

- **Vite** build tooling
- **xterm.js** terminal emulator with FitAddon
- **React** for all UI chrome (drawer, toolbar, overlays, session picker)
- Single xterm.js instance attached to the tmux client PTY. Tmux handles rendering the active pane/window. The UI sends `tmux select-pane`/`tmux select-window` commands to switch context.

---

## Session Lifecycle

### Connection Flow

1. User runs `npx tmux-mobile` on their server
2. Server starts Express on a local port
3. Server starts cloudflared quick tunnel, prints public URL + QR code
4. User scans QR code on phone, opens the URL

### Authentication

- **Token-based URL**: Server generates a unique token on startup, embedded in the cloudflared URL (e.g., `https://xxx.trycloudflare.com/?token=abc123`)
- **Optional password**: `-p` flag to require a password on top of the token (like porterminal)
- Password auth uses the same approach as porterminal: first message on WebSocket is auth, saved in localStorage

### Tmux Attach Flow

1. On authenticated WebSocket connection, server lists existing tmux sessions via `tmux list-sessions`
2. **If 0 sessions**: Create a new session via `tmux new-session -d -s main`, then attach
3. **If 1 session**: Auto-attach to it
4. **If multiple sessions**: Send session list to client, client shows a session picker overlay
5. Attachment: Server spawns PTY running `tmux attach-session -t <session-name>`. This PTY is the data plane source.
6. The PTY process IS tmux. Server always knows which session it's attached to.

---

## UI Layout

### Main Screen (Portrait)

```
+----------------------------------+
|  [=] Session: main     [scroll]  |  <- Top bar (hamburger=drawer, session name, scroll=copy mode)
|                                  |
|                                  |
|       xterm.js terminal          |
|                                  |
|                                  |
|                                  |
+----------------------------------+
| Esc  1 2 3 Tab / Del [BS] Hm Up Ed Enter |  <- Toolbar row 1
| Ctrl Alt Sft ^D ^C ^L ^R Paste  <- -> Dn  |  <- Toolbar row 2
+----------------------------------+
| [compose input field]    [Send]  |  <- Compose mode (toggleable)
+----------------------------------+
```

### Main Screen (Landscape)

Same layout but terminal gets more columns, fewer rows. Toolbar may collapse to single row or use smaller buttons.

### Left Drawer

Slide-in from left edge (swipe or hamburger button). Contains:

```
+---------------------+
| SESSIONS            |
|  > main (attached)  |
|    work              |
|    dev               |
|  [+ New Session]    |
|---------------------|
| WINDOWS (main)      |
|  0: bash *          |
|  1: vim             |
|  2: htop            |
|  [+ New Window]     |
|---------------------|
| PANES (window 0)    |
|  %0: bash (active)  |
|  %1: node           |
|  [Split H] [Split V]|
|---------------------|
| [Close Pane]        |
| [Kill Window]       |
+---------------------+
```

- Flat list for each level (sessions, windows, panes)
- Each pane entry shows: pane index, running command (from `pane_current_command`), active indicator
- Tapping a session switches to it (server runs `tmux switch-client`)
- Tapping a window selects it (`tmux select-window`)
- Tapping a pane selects it (`tmux select-pane`)
- Action buttons: New Session, New Window, Split Horizontal, Split Vertical, Close Pane, Kill Window

---

## Toolbar Buttons

### Row 1 (Navigation & Editing)
| Button | Key | Sequence | Notes |
|--------|-----|----------|-------|
| Esc | Escape | `\x1b` | Double-tap sends `\x1b\x1b` |
| 1 | 1 | `1` | |
| 2 | 2 | `2` | |
| 3 | 3 | `3` | |
| Tab | Tab | `\t` | |
| / | / | `/` | |
| Del | Delete | `\x1b[3~` | |
| BS | Backspace | `\x7f` | Hold to repeat |
| Hm | Home | `\x1b[H` | |
| Up | Arrow Up | `\x1b[A` | |
| Ed | End | `\x1b[F` | |
| Enter | Enter | `\r` | |

### Row 2 (Modifiers & Shortcuts)
| Button | Key | Sequence | Notes |
|--------|-----|----------|-------|
| Ctrl | Modifier | - | Tap=sticky, double-tap=locked |
| Alt | Modifier | - | Tap=sticky, double-tap=locked |
| Sft | Modifier | - | Tap=sticky, double-tap=locked |
| ^D | Ctrl+D | `\x04` | EOF/exit |
| ^C | Ctrl+C | `\x03` | Interrupt (red) |
| ^L | Ctrl+L | `\x0c` | Clear screen |
| ^R | Ctrl+R | `\x12` | Reverse search |
| Paste | Clipboard | - | Async clipboard read |
| Left | Arrow Left | `\x1b[D` | |
| Down | Arrow Down | `\x1b[B` | |
| Right | Arrow Right | `\x1b[C` | |

### Modifier Behavior (from porterminal)
- **Tap**: Sticky mode - modifier applies to next key only, then auto-clears
- **Double-tap** (within 300ms): Locked mode - modifier stays on until tapped again
- Visual indicator: highlight for sticky, strong highlight for locked

---

## Tmux Operations via Server CLI

All tmux structural operations are executed server-side via the `tmux` CLI, NOT through key sequences in the PTY.

### State Queries (used for drawer, polling)
```
tmux list-sessions -F '#{session_name}:#{session_attached}:#{session_windows}'
tmux list-windows -t <session> -F '#{window_index}:#{window_name}:#{window_active}:#{window_panes}'
tmux list-panes -t <session>:<window> -F '#{pane_index}:#{pane_id}:#{pane_current_command}:#{pane_active}:#{pane_width}x#{pane_height}'
```

### Mutations (triggered by drawer actions)
```
tmux new-session -d -s <name>          # Create session
tmux kill-session -t <name>            # Kill session
tmux switch-client -t <session>        # Switch session
tmux new-window -t <session>           # New window
tmux kill-window -t <session>:<window> # Kill window
tmux select-window -t <session>:<idx>  # Switch window
tmux split-window -h -t <pane_id>      # Split horizontal
tmux split-window -v -t <pane_id>      # Split vertical
tmux kill-pane -t <pane_id>            # Close pane
tmux select-pane -t <pane_id>          # Switch pane
```

### Scrollback Capture (for copy mode)
```
tmux capture-pane -t <pane_id> -p -S -<lines>  # Capture last N lines
```

### State Monitoring
- Poll `tmux list-sessions`, `list-windows`, `list-panes` every 2-3 seconds
- Diff against previous state, push changes to client via control plane WebSocket
- Only send updates when state actually changes (session/window/pane added/removed, active changed, command changed)

---

## Custom Scrollback Viewer (Copy Mode)

Instead of fighting with tmux's native copy mode on mobile:

1. User taps "Scroll" button in top bar
2. Client sends request to server via control plane
3. Server runs `tmux capture-pane -t <pane_id> -p -S -1000` (default: last 1000 lines)
4. Server sends captured text to client
5. Client shows a full-screen overlay with:
   - Native mobile scrolling (touch scroll, momentum)
   - Native text selection (long-press to select, handles to adjust)
   - "Copy" button that copies selection to clipboard
   - "Load More" button to fetch additional history
   - "Close" button to return to terminal
6. Configurable default line count (1000 default, user can change)

---

## Compose Mode

Toggleable text input mode (on by default for mobile):

- Native text input field at bottom of screen, above or replacing toolbar
- User types command using native mobile keyboard (with autocomplete, spell-check, etc.)
- "Send" button or Enter key sends the text to the terminal + carriage return
- Toggle button to switch between compose mode and direct terminal input
- When compose mode is off, tapping the terminal area brings up the mobile keyboard for direct xterm.js input

---

## Cloudflared Integration

- On startup, check if `cloudflared` is in PATH
- If not found, attempt auto-install (brew on macOS, direct download on Linux)
- Start a quick tunnel: `cloudflared tunnel --url http://localhost:<port>`
- Parse stdout for the tunnel URL
- Display URL + QR code in the server terminal
- Append auth token to URL as query parameter
- On shutdown, kill the cloudflared process

---

## Configuration

### CLI Flags
```
npx tmux-mobile [options]

Options:
  -p, --port <port>     Local port (default: 8767)
  --password <pass>     Require password authentication
  --no-tunnel           Don't start cloudflared tunnel (localhost only)
  --session <name>      Default tmux session name (default: "main")
  --scrollback <lines>  Default scrollback capture lines (default: 1000)
```

---

## Non-Goals (Explicitly Out of Scope for MVP)

- Pane resize from UI (use tmux commands directly if needed)
- Pane layout diagram / spatial visualization
- Multiple simultaneous clients with conflict resolution
- Custom themes / color schemes
- File upload/download
- SSH tunneling (cloudflared only)
- Desktop-optimized layout (mobile-first, works on desktop but not optimized)
