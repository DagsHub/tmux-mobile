import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { themes } from "./themes";
import type {
  ControlServerMessage,
  TmuxPaneState,
  TmuxSessionState,
  TmuxSessionSummary,
  TmuxStateSnapshot,
  TmuxWindowState
} from "./types/protocol";

interface ServerConfig {
  passwordRequired: boolean;
  scrollbackLines: number;
  pollIntervalMs: number;
  approvalEnabled: boolean;
}

type ModifierKey = "ctrl" | "alt" | "shift" | "meta";
type ModifierMode = "off" | "sticky" | "locked";

declare global {
  interface Window {
    __tmuxMobileDebugEvents?: Array<{
      at: string;
      event: string;
      payload?: unknown;
    }>;
    __tmuxMobileDebugState?: unknown;
  }
}

const query = new URLSearchParams(window.location.search);
const token = query.get("token") ?? "";
const debugMode = query.get("debug") === "1";

const wsOrigin = (() => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}`;
})();

const getPreferredTerminalFontSize = (): number => {
  return window.matchMedia("(max-width: 768px), (pointer: coarse)").matches ? 12 : 14;
};

const getInitialStickyZoom = (): boolean => {
  const stored = localStorage.getItem("tmux-mobile-sticky-zoom");
  if (stored === "true") {
    return true;
  }
  if (stored === "false") {
    return false;
  }
  return window.matchMedia("(max-width: 768px)").matches;
};

const parseMessage = (raw: string): ControlServerMessage | null => {
  try {
    return JSON.parse(raw) as ControlServerMessage;
  } catch {
    return null;
  }
};

const debugLog = (event: string, payload?: unknown): void => {
  if (!debugMode) {
    return;
  }
  const entry = {
    at: new Date().toISOString(),
    event,
    payload
  };
  const current = window.__tmuxMobileDebugEvents ?? [];
  current.push(entry);
  if (current.length > 500) {
    current.splice(0, current.length - 500);
  }
  window.__tmuxMobileDebugEvents = current;
  console.log("[tmux-mobile-debug]", entry.at, event, payload ?? "");
};

export const App = () => {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const controlSocketRef = useRef<WebSocket | null>(null);
  const terminalSocketRef = useRef<WebSocket | null>(null);

  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [password, setPassword] = useState(localStorage.getItem("tmux-mobile-password") ?? "");
  const [needsPasswordInput, setNeedsPasswordInput] = useState(false);
  const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
  const [authReady, setAuthReady] = useState(false);

  // Approval flow state
  const [pendingApproval, setPendingApproval] = useState(false);
  const [challengeCode, setChallengeCode] = useState("");
  // JWT is stored in localStorage (accessible to JS on the page). This is acceptable here
  // because the app is a single-origin terminal client with no third-party scripts.
  const jwtRef = useRef<string | null>(localStorage.getItem("tmux-mobile-jwt"));

  const [snapshot, setSnapshot] = useState<TmuxStateSnapshot>({ sessions: [], capturedAt: "" });
  const [attachedSession, setAttachedSession] = useState<string>("");
  const [sessionChoices, setSessionChoices] = useState<TmuxSessionSummary[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composeEnabled, setComposeEnabled] = useState(true);
  const [composeText, setComposeText] = useState("");

  const [scrollbackVisible, setScrollbackVisible] = useState(false);
  const [scrollbackText, setScrollbackText] = useState("");
  const [scrollbackLines, setScrollbackLines] = useState(1000);

  const [modifiers, setModifiers] = useState<Record<ModifierKey, ModifierMode>>({
    ctrl: "off",
    alt: "off",
    shift: "off",
    meta: "off"
  });
  const modifierTapRef = useRef<{ key: ModifierKey; at: number } | null>(null);

  const [theme, setTheme] = useState(localStorage.getItem("tmux-mobile-theme") ?? "midnight");
  const [toolbarExpanded, setToolbarExpanded] = useState(
    localStorage.getItem("tmux-mobile-toolbar-expanded") === "true"
  );
  const [toolbarDeepExpanded, setToolbarDeepExpanded] = useState(false);
  const [stickyZoom, setStickyZoom] = useState(getInitialStickyZoom);

  const activeSession: TmuxSessionState | undefined = useMemo(() => {
    const selected = snapshot.sessions.find((session) => session.name === attachedSession);
    if (selected) {
      return selected;
    }
    return snapshot.sessions.find((session) => session.attached) ?? snapshot.sessions[0];
  }, [snapshot.sessions, attachedSession]);

  const activeWindow: TmuxWindowState | undefined = useMemo(() => {
    if (!activeSession) {
      return undefined;
    }
    return activeSession.windowStates.find((window) => window.active) ?? activeSession.windowStates[0];
  }, [activeSession]);

  const activePane: TmuxPaneState | undefined = useMemo(() => {
    if (!activeWindow) {
      return undefined;
    }
    return activeWindow.panes.find((pane) => pane.active) ?? activeWindow.panes[0];
  }, [activeWindow]);

  const topStatus = useMemo(() => {
    if (errorMessage) {
      return { kind: "error", label: errorMessage };
    }
    if (statusMessage.toLowerCase().includes("disconnected")) {
      return { kind: "warn", label: statusMessage };
    }
    if (statusMessage.toLowerCase().includes("connected")) {
      return { kind: "ok", label: statusMessage };
    }
    if (statusMessage) {
      return { kind: "pending", label: statusMessage };
    }
    if (authReady) {
      return { kind: "ok", label: "connected" };
    }
    return { kind: "pending", label: "connecting" };
  }, [authReady, errorMessage, statusMessage]);

  const sendControl = (payload: Record<string, unknown>): void => {
    if (controlSocketRef.current?.readyState !== WebSocket.OPEN) {
      debugLog("send_control.blocked", {
        payload,
        readyState: controlSocketRef.current?.readyState
      });
      setErrorMessage("control websocket disconnected");
      return;
    }
    setErrorMessage("");
    debugLog("send_control", payload);
    controlSocketRef.current.send(JSON.stringify(payload));
  };

  const clearStickyModifiers = (): void => {
    setModifiers((previous) => ({
      ctrl: previous.ctrl === "sticky" ? "off" : previous.ctrl,
      alt: previous.alt === "sticky" ? "off" : previous.alt,
      shift: previous.shift === "sticky" ? "off" : previous.shift,
      meta: previous.meta === "sticky" ? "off" : previous.meta
    }));
  };

  const applyModifiers = (input: string): string => {
    let output = input;

    if (modifiers.shift !== "off" && output.length === 1 && /^[a-z]$/.test(output)) {
      output = output.toUpperCase();
    }

    if (modifiers.ctrl !== "off" && output.length === 1) {
      output = String.fromCharCode(output.toUpperCase().charCodeAt(0) & 31);
    }

    if (modifiers.alt !== "off" || modifiers.meta !== "off") {
      output = `\u001b${output}`;
    }

    clearStickyModifiers();
    return output;
  };

  const sendTerminal = (input: string, withModifiers = true): void => {
    const socket = terminalSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      debugLog("send_terminal.blocked", {
        readyState: socket?.readyState,
        withModifiers,
        bytes: input.length
      });
      return;
    }
    const output = withModifiers ? applyModifiers(input) : input;
    debugLog("send_terminal", { withModifiers, inputBytes: input.length, outputBytes: output.length });
    socket.send(output);
  };

  const sendTerminalResize = (): void => {
    const socket = terminalSocketRef.current;
    const terminal = terminalRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !terminal) {
      debugLog("send_terminal_resize.blocked", {
        socketReadyState: socket?.readyState,
        hasTerminal: Boolean(terminal)
      });
      return;
    }
    debugLog("send_terminal_resize", { cols: terminal.cols, rows: terminal.rows });
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows
      })
    );
  };

  const toggleModifier = (key: ModifierKey): void => {
    const now = Date.now();
    const isDoubleTap =
      modifierTapRef.current &&
      modifierTapRef.current.key === key &&
      now - modifierTapRef.current.at <= 300;

    modifierTapRef.current = { key, at: now };

    setModifiers((previous) => {
      const current = previous[key];
      let next: ModifierMode;

      if (current === "locked") {
        next = "off";
      } else if (isDoubleTap) {
        next = "locked";
      } else {
        next = current === "sticky" ? "off" : "sticky";
      }

      return {
        ...previous,
        [key]: next
      };
    });
  };

  const requestScrollback = (lines: number): void => {
    if (!activePane) {
      return;
    }
    setScrollbackLines(lines);
    sendControl({ type: "capture_scrollback", paneId: activePane.id, lines });
  };

  const formatPasswordError = (reason: string): string => {
    if (reason === "invalid password") {
      return "Wrong password. Try again.";
    }
    return reason;
  };

  const openTerminalSocket = (passwordValue: string, clientId: string, jwtValue?: string | null): void => {
    debugLog("terminal_socket.open.begin", { hasPassword: Boolean(passwordValue), hasJwt: Boolean(jwtValue) });
    terminalSocketRef.current?.close();

    const socket = new WebSocket(`${wsOrigin}/ws/terminal`);
    socket.onopen = () => {
      const authPayload: Record<string, unknown> = { type: "auth", token, clientId };
      if (jwtValue) {
        authPayload.jwt = jwtValue;
      } else if (passwordValue) {
        authPayload.password = passwordValue;
      }
      socket.send(JSON.stringify(authPayload));
      setStatusMessage("terminal connected");
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
      }
      sendTerminalResize();
    };

    socket.onmessage = (event) => {
      debugLog("terminal_socket.onmessage", {
        type: typeof event.data,
        bytes: typeof event.data === "string" ? event.data.length : 0
      });
      terminalRef.current?.write(typeof event.data === "string" ? event.data : "");
    };

    socket.onclose = (event) => {
      debugLog("terminal_socket.onclose", { code: event.code, reason: event.reason });
      if (event.code === 4001) {
        setErrorMessage("terminal authentication failed");
      }
      setStatusMessage("terminal disconnected");
    };
    socket.onerror = () => {
      debugLog("terminal_socket.onerror");
      setErrorMessage("terminal websocket error");
    };

    terminalSocketRef.current = socket;
  };

  const openControlSocket = (passwordValue: string, jwtValue?: string | null): void => {
    debugLog("control_socket.open.begin", { hasPassword: Boolean(passwordValue), hasJwt: Boolean(jwtValue) });
    controlSocketRef.current?.close();

    const socket = new WebSocket(`${wsOrigin}/ws/control`);

    socket.onopen = () => {
      const authPayload: Record<string, unknown> = { type: "auth", token };
      if (jwtValue) {
        authPayload.jwt = jwtValue;
      } else if (passwordValue) {
        authPayload.password = passwordValue;
      }
      socket.send(JSON.stringify(authPayload));
    };

    socket.onmessage = (event) => {
      debugLog("control_socket.onmessage.raw", { bytes: String(event.data).length });
      const message = parseMessage(String(event.data));
      if (!message) {
        debugLog("control_socket.onmessage.parse_error", { raw: String(event.data) });
        return;
      }
      debugLog("control_socket.onmessage", { type: message.type });

      switch (message.type) {
        case "auth_ok":
          debugLog("control_socket.auth_ok", {
            clientId: message.clientId,
            requiresPassword: message.requiresPassword
          });
          setErrorMessage("");
          setPasswordErrorMessage("");
          setAuthReady(true);
          setNeedsPasswordInput(false);
          setPendingApproval(false);
          if (message.requiresPassword && passwordValue) {
            localStorage.setItem("tmux-mobile-password", passwordValue);
          } else {
            localStorage.removeItem("tmux-mobile-password");
          }
          openTerminalSocket(passwordValue, message.clientId);
          return;
        case "auth_approved": {
          // Store JWT, remove cleartext password
          jwtRef.current = message.jwt;
          localStorage.setItem("tmux-mobile-jwt", message.jwt);
          localStorage.removeItem("tmux-mobile-password");
          setErrorMessage("");
          setPasswordErrorMessage("");
          setAuthReady(true);
          setNeedsPasswordInput(false);
          setPendingApproval(false);
          setChallengeCode("");
          openTerminalSocket("", message.clientId, message.jwt);
          return;
        }
        case "auth_pending":
          setPendingApproval(true);
          setChallengeCode(message.challengeCode);
          setErrorMessage("");
          setStatusMessage("Waiting for server approval...");
          return;
        case "auth_denied":
          setPendingApproval(false);
          setChallengeCode("");
          setErrorMessage(message.reason);
          setNeedsPasswordInput(true);
          setPasswordErrorMessage("Connection denied. Enter password to connect.");
          return;
        case "auth_error":
          debugLog("control_socket.auth_error", { reason: message.reason });
          setErrorMessage(message.reason);
          setAuthReady(false);
          // If JWT auth failed, clear stored JWT and fall through
          if (jwtValue) {
            jwtRef.current = null;
            localStorage.removeItem("tmux-mobile-jwt");
          }
          const passwordAuthFailed =
            message.reason === "invalid password" || Boolean(serverConfig?.passwordRequired);
          if (passwordAuthFailed) {
            setNeedsPasswordInput(true);
            setPasswordErrorMessage(formatPasswordError(message.reason));
            localStorage.removeItem("tmux-mobile-password");
          }
          return;
        case "attached":
          debugLog("control_socket.attached", { session: message.session });
          setAttachedSession(message.session);
          setSessionChoices(null);
          setDrawerOpen(false);
          setStatusMessage(`attached: ${message.session}`);
          if (fitAddonRef.current) {
            fitAddonRef.current.fit();
          }
          sendTerminalResize();
          return;
        case "session_picker":
          debugLog("control_socket.session_picker", {
            sessions: message.sessions.map((session) => ({
              name: session.name,
              attached: session.attached,
              windows: session.windows
            }))
          });
          setSessionChoices(message.sessions);
          return;
        case "tmux_state":
          debugLog("control_socket.tmux_state", {
            capturedAt: message.state.capturedAt,
            sessionCount: message.state.sessions.length,
            sessions: message.state.sessions.map((session) => {
              const activeWindow =
                session.windowStates.find((windowState) => windowState.active) ?? session.windowStates[0];
              const activePane = activeWindow?.panes.find((pane) => pane.active) ?? activeWindow?.panes[0];
              return {
                name: session.name,
                attached: session.attached,
                activeWindow: activeWindow ? `${activeWindow.index}:${activeWindow.name}` : null,
                activePane: activePane?.id ?? null,
                activePaneZoomed: activePane?.zoomed ?? null
              };
            })
          });
          setSnapshot(message.state);
          return;
        case "scrollback":
          debugLog("control_socket.scrollback", {
            paneId: message.paneId,
            lines: message.lines,
            bytes: message.text.length
          });
          setScrollbackText(message.text);
          setScrollbackVisible(true);
          return;
        case "error":
          debugLog("control_socket.error", { message: message.message });
          setErrorMessage(message.message);
          return;
        case "info":
          debugLog("control_socket.info", { message: message.message });
          setStatusMessage(message.message);
          return;
      }
    };

    socket.onclose = () => {
      debugLog("control_socket.onclose");
      setAuthReady(false);
    };

    controlSocketRef.current = socket;
  };

  useEffect(() => {
    if (!token) {
      setErrorMessage("Missing token in URL");
      return;
    }

    debugLog("config.fetch.begin");
    fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`config request failed: ${response.status}`);
        }
        const config = (await response.json()) as ServerConfig;
        debugLog("config.fetch.ok", config);
        setServerConfig(config);

        // Try JWT first if stored
        const storedJwt = jwtRef.current;
        if (storedJwt) {
          openControlSocket("", storedJwt);
          return;
        }

        // If password required and no password stored, show prompt
        if (config.passwordRequired && !password) {
          // If approval is enabled and no password, connect without password to trigger approval
          if (config.approvalEnabled) {
            openControlSocket("");
            return;
          }
          debugLog("config.fetch.password_required");
          setNeedsPasswordInput(true);
          setPasswordErrorMessage("");
          return;
        }

        openControlSocket(password);
      })
      .catch((error: Error) => {
        debugLog("config.fetch.error", { message: error.message });
        setErrorMessage(error.message);
      });
  }, []);

  // Theme effect: apply data-theme attribute, persist, update xterm theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tmux-mobile-theme", theme);
    const themeConfig = themes[theme];
    if (themeConfig && terminalRef.current) {
      terminalRef.current.options.theme = themeConfig.xterm;
    }
  }, [theme]);

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const initialFontSize = getPreferredTerminalFontSize();
    const themeConfig = themes[theme];
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'MesloLGS NF', 'MesloLGM NF', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'DejaVu Sans Mono Nerd Font', 'Symbols Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: initialFontSize,
      theme: themeConfig?.xterm ?? {
        background: "#0d1117",
        foreground: "#d1e4ff",
        cursor: "#93c5fd"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalContainerRef.current);
    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });

    const disposable = terminal.onData((data) => {
      sendTerminal(data);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndNotifyResize = () => {
      const preferredFontSize = getPreferredTerminalFontSize();
      if (terminal.options.fontSize !== preferredFontSize) {
        terminal.options.fontSize = preferredFontSize;
      }
      fitAddon.fit();
      sendTerminalResize();
    };

    const onResize = () => {
      fitAndNotifyResize();
    };

    window.addEventListener("resize", onResize);
    const resizeObserver = new ResizeObserver(() => {
      fitAndNotifyResize();
    });
    resizeObserver.observe(terminalContainerRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
      disposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      controlSocketRef.current?.close();
      terminalSocketRef.current?.close();
    };
  }, []);

  // Persist toolbar expanded state
  useEffect(() => {
    localStorage.setItem("tmux-mobile-toolbar-expanded", toolbarExpanded ? "true" : "false");
  }, [toolbarExpanded]);

  // Persist sticky zoom state
  useEffect(() => {
    localStorage.setItem("tmux-mobile-sticky-zoom", stickyZoom ? "true" : "false");
  }, [stickyZoom]);

  useEffect(() => {
    if (!debugMode) {
      return;
    }
    const sessionSummary = snapshot.sessions.map((session) => {
      const activeWindow =
        session.windowStates.find((windowState) => windowState.active) ?? session.windowStates[0];
      const activePane = activeWindow?.panes.find((pane) => pane.active) ?? activeWindow?.panes[0];
      return {
        name: session.name,
        attached: session.attached,
        activeWindow: activeWindow ? `${activeWindow.index}:${activeWindow.name}` : null,
        activePane: activePane?.id ?? null,
        activePaneZoomed: activePane?.zoomed ?? null
      };
    });
    const derived = {
      attachedSession,
      activeSession: activeSession?.name ?? null,
      activeWindow: activeWindow ? `${activeWindow.index}:${activeWindow.name}` : null,
      activePane: activePane?.id ?? null,
      activePaneZoomed: activePane?.zoomed ?? null,
      topStatus,
      snapshotCapturedAt: snapshot.capturedAt,
      sessions: sessionSummary
    };
    window.__tmuxMobileDebugState = derived;
    debugLog("derived_state", derived);
  }, [attachedSession, activeSession, activeWindow, activePane, snapshot, topStatus]);

  const submitPassword = (): void => {
    setPasswordErrorMessage("");
    setPendingApproval(false);
    openControlSocket(password);
  };

  const switchToPasswordEntry = (): void => {
    setPendingApproval(false);
    setChallengeCode("");
    setNeedsPasswordInput(true);
    setPasswordErrorMessage("");
    controlSocketRef.current?.close();
  };

  const createSession = (): void => {
    const name = window.prompt("Session name", "main");
    if (!name) {
      return;
    }
    sendControl({ type: "new_session", name });
  };

  const copySelection = async (): Promise<void> => {
    const selected = window.getSelection()?.toString() || scrollbackText;
    await navigator.clipboard.writeText(selected);
    setStatusMessage("Copied to clipboard");
  };

  const focusTerminal = (): void => {
    terminalRef.current?.focus();
  };

  const selectWindow = (windowState: TmuxWindowState): void => {
    if (!activeSession) {
      return;
    }
    sendControl({
      type: "select_window",
      session: activeSession.name,
      windowIndex: windowState.index,
      ...(stickyZoom && !windowState.active ? { stickyZoom: true } : {})
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          onClick={() => setDrawerOpen((value) => !value)}
          className="icon-btn"
          data-testid="drawer-toggle"
        >
          =
        </button>
        <div className="top-title">
          Window: {activeWindow ? `${activeWindow.index}: ${activeWindow.name}` : "-"}
        </div>
        <div className="top-actions">
          <span
            className={`top-status ${topStatus.kind}`}
            title={topStatus.label}
            aria-label={`Status: ${topStatus.label}`}
            data-testid="top-status-indicator"
          />
          <button
            className={`top-zoom-indicator${activePane?.zoomed ? " on" : ""}`}
            title={activePane?.zoomed ? "Active pane is zoomed" : "Active pane is not zoomed"}
            aria-label={`Pane zoom: ${activePane?.zoomed ? "on" : "off"}`}
            data-testid="top-zoom-indicator"
            onClick={() => activePane && sendControl({ type: "zoom_pane", paneId: activePane.id })}
            disabled={!activePane || !activeWindow || activeWindow.paneCount <= 1}
          >
            🔍
          </button>
          <button className="top-btn" onClick={() => requestScrollback(serverConfig?.scrollbackLines ?? 1000)}>
            Scroll
          </button>
          <button className="top-btn" onClick={() => setComposeEnabled((value) => !value)}>
            {composeEnabled ? "Compose On" : "Compose Off"}
          </button>
        </div>
      </header>

      <main className="terminal-wrap">
        <div
          className="terminal-host"
          ref={terminalContainerRef}
          data-testid="terminal-host"
          onContextMenu={(event) => event.preventDefault()}
        />
      </main>

      <section className="toolbar" onMouseUp={focusTerminal}>
        {/* Row 1: Esc, Ctrl, Alt, Cmd, Meta, /, @, Hm, up, Ed */}
        <div className="toolbar-main">
          <button onClick={() => sendTerminal("\u001b")}>Esc</button>
          <button className={`modifier ${modifiers.ctrl}`} onClick={() => toggleModifier("ctrl")}>Ctrl</button>
          <button className={`modifier ${modifiers.alt}`} onClick={() => toggleModifier("alt")}>Alt</button>
          <button className={`modifier ${modifiers.meta}`} onClick={() => toggleModifier("meta")}>Cmd</button>
          <button onClick={() => sendTerminal("\u001b")}>Meta</button>
          <button onClick={() => sendTerminal("/")}>/</button>
          <button onClick={() => sendTerminal("@")}>@</button>
          <button onClick={() => sendTerminal("\u001b[H")}>Hm</button>
          <button onClick={() => sendTerminal("\u001b[A")}>up</button>
          <button onClick={() => sendTerminal("\u001b[F")}>Ed</button>
        </div>

        {/* Row 2: ^C, ^B, ^R, Sft, Tab, Enter, ..., left, down, right */}
        <div className="toolbar-main">
          <button className="danger" onClick={() => sendTerminal("\u0003", false)}>^C</button>
          <button onClick={() => sendTerminal("\u0002", false)}>^B</button>
          <button onClick={() => sendTerminal("\u0012", false)}>^R</button>
          <button className={`modifier ${modifiers.shift}`} onClick={() => toggleModifier("shift")}>Sft</button>
          <button onClick={() => sendTerminal("\t")}>Tab</button>
          <button onClick={() => sendTerminal("\r")}>Enter</button>
          <button
            className="toolbar-expand-btn"
            onClick={() => {
              setToolbarExpanded((v) => !v);
              if (toolbarExpanded) {
                setToolbarDeepExpanded(false);
              }
            }}
          >
            {toolbarExpanded ? "..." : "..."}
          </button>
          <button onClick={() => sendTerminal("\u001b[D")}>left</button>
          <button onClick={() => sendTerminal("\u001b[B")}>down</button>
          <button onClick={() => sendTerminal("\u001b[C")}>right</button>
        </div>

        {/* Expanded section (collapsible) */}
        <div className={`toolbar-row-secondary ${toolbarExpanded ? "expanded" : ""}`}>
          <button onClick={() => sendTerminal("\u0004", false)}>^D</button>
          <button onClick={() => sendTerminal("\u000c", false)}>^L</button>
          <button
            onClick={async () => {
              const clip = await navigator.clipboard.readText();
              sendTerminal(clip, false);
            }}
          >
            Paste
          </button>
          <button onClick={() => sendTerminal("\u001b[3~")}>Del</button>
          <button onClick={() => sendTerminal("\u001b[2~")}>Insert</button>
          <button onClick={() => sendTerminal("\u001b[5~")}>PgUp</button>
          <button onClick={() => sendTerminal("\u001b[6~")}>PgDn</button>
          <button onClick={() => sendTerminal("")}>CapsLk</button>
          <button
            className="toolbar-expand-btn"
            onClick={() => setToolbarDeepExpanded((v) => !v)}
          >
            {toolbarDeepExpanded ? "F-Keys ▲" : "F-Keys ▼"}
          </button>
        </div>

        {/* F-keys row (collapsible from within expanded) */}
        {toolbarExpanded && (
          <div className={`toolbar-row-deep ${toolbarDeepExpanded ? "expanded" : ""}`}>
            <div className="toolbar-row-deep-fkeys">
              {[
                "\u001bOP", "\u001bOQ", "\u001bOR", "\u001bOS",
                "\u001b[15~", "\u001b[17~", "\u001b[18~", "\u001b[19~",
                "\u001b[20~", "\u001b[21~", "\u001b[23~", "\u001b[24~"
              ].map((seq, i) => (
                <button key={`f${i + 1}`} onClick={() => sendTerminal(seq, false)}>
                  F{i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {composeEnabled && (
        <section className="compose-bar">
          <input
            value={composeText}
            onChange={(event) => setComposeText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                sendControl({ type: "send_compose", text: composeText });
                setComposeText("");
              }
            }}
            placeholder="Compose command"
          />
          <button
            onClick={() => {
              sendControl({ type: "send_compose", text: composeText });
              setComposeText("");
            }}
          >
            Send
          </button>
        </section>
      )}

      {drawerOpen && (
        <div
          className="drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          data-testid="drawer-backdrop"
        >
          <aside className="drawer" onClick={(event) => event.stopPropagation()}>
            <button
              className="drawer-close"
              onClick={() => setDrawerOpen(false)}
              data-testid="drawer-close"
              aria-label="Close drawer"
            >
              ←
            </button>

            <h3>Sessions</h3>
            <ul data-testid="sessions-list">
              {snapshot.sessions.map((session) => (
                <li key={session.name}>
                  <button
                    onClick={() => sendControl({ type: "select_session", session: session.name })}
                    className={session.name === (attachedSession || activeSession?.name) ? "active" : ""}
                  >
                    {session.name} {session.attached ? "*" : ""}
                  </button>
                </li>
              ))}
            </ul>
            <button
              className="drawer-section-action"
              onClick={createSession}
              data-testid="new-session-button"
            >
              + New Session
            </button>

            <h3>Windows ({activeSession?.name ?? "-"})</h3>
            <ul data-testid="windows-list">
              {activeSession
                ? activeSession.windowStates.map((windowState) => (
                    <li key={`${activeSession.name}-${windowState.index}`}>
                      <button
                        onClick={() => selectWindow(windowState)}
                        className={windowState.active ? "active" : ""}
                      >
                        {windowState.index}: {windowState.name} {windowState.active ? "*" : ""}
                      </button>
                    </li>
                  ))
                : null}
            </ul>
            <button
              className="drawer-section-action"
              onClick={() =>
                activeSession && sendControl({ type: "new_window", session: activeSession.name })
              }
              disabled={!activeSession}
              data-testid="new-window-button"
            >
              + New Window
            </button>

            <h3>Panes ({activeWindow ? `${activeWindow.index}` : "-"})</h3>
            <ul>
              {activeWindow
                ? activeWindow.panes.map((pane) => (
                    <li key={pane.id}>
                      <button
                        onClick={() => sendControl({
                          type: "select_pane",
                          paneId: pane.id,
                          ...(stickyZoom && !pane.active ? { stickyZoom: true } : {})
                        })}
                        className={pane.active ? "active" : ""}
                      >
                        %{pane.index}: {pane.currentCommand} {pane.active ? "*" : ""}
                        {pane.active && pane.zoomed ? (
                          <span
                            className="pane-zoom-indicator on"
                            title="Active pane is zoomed"
                            aria-label="Pane zoom: on"
                            data-testid="active-pane-zoom-indicator"
                          >
                            🔍
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))
                : null}
            </ul>
            <div className="drawer-grid">
              <button
                onClick={() =>
                  activePane &&
                  sendControl({ type: "split_pane", paneId: activePane.id, orientation: "h" })
                }
                disabled={!activePane}
              >
                Split H
              </button>
              <button
                onClick={() =>
                  activePane &&
                  sendControl({ type: "split_pane", paneId: activePane.id, orientation: "v" })
                }
                disabled={!activePane}
              >
                Split V
              </button>
            </div>
            <button
              className="drawer-section-action"
              onClick={() =>
                activePane && sendControl({ type: "zoom_pane", paneId: activePane.id })
              }
              disabled={!activePane || !activeWindow || activeWindow.paneCount <= 1}
            >
              Zoom Pane
            </button>
            <button
              className={`drawer-section-action${stickyZoom ? " active" : ""}`}
              onClick={() => setStickyZoom((v) => !v)}
              data-testid="sticky-zoom-toggle"
            >
              Sticky Zoom: {stickyZoom ? "On" : "Off"}
            </button>

            <button
              className="drawer-section-action"
              onClick={() => activePane && sendControl({ type: "kill_pane", paneId: activePane.id })}
              disabled={!activePane}
            >
              Close Pane
            </button>
            <button
              className="drawer-section-action"
              onClick={() =>
                activeSession &&
                activeWindow &&
                sendControl({
                  type: "kill_window",
                  session: activeSession.name,
                  windowIndex: activeWindow.index
                })
              }
              disabled={!activeSession || !activeWindow}
            >
              Kill Window
            </button>

            <h3>Appearance</h3>
            <div className="theme-picker" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
              {Object.entries(themes).map(([key, config]) => (
                <button
                  key={key}
                  className={theme === key ? "active" : ""}
                  onClick={() => setTheme(key)}
                >
                  {config.name}
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}

      {sessionChoices && (
        <div className="overlay" data-testid="session-picker-overlay">
          <div className="card">
            <h2>Select Session</h2>
            {sessionChoices.map((session) => (
              <button
                key={session.name}
                onClick={() => sendControl({ type: "select_session", session: session.name })}
              >
                {session.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {scrollbackVisible && (
        <div className="overlay">
          <div className="card scrollback-card">
            <div className="scrollback-actions">
              <button onClick={() => setScrollbackVisible(false)}>Close</button>
              <button onClick={() => requestScrollback(scrollbackLines + 1000)}>Load More</button>
              <button onClick={() => void copySelection()}>Copy</button>
            </div>
            <pre className="scrollback-text">{scrollbackText}</pre>
          </div>
        </div>
      )}

      {pendingApproval && (
        <div className="overlay" data-testid="approval-overlay">
          <div className="card approval-card">
            <h2>Waiting for Approval</h2>
            <p className="approval-subtitle">
              The server operator must approve this connection.
            </p>
            <div className="challenge-code" data-testid="challenge-code">
              {challengeCode}
            </div>
            <p className="approval-hint">
              Confirm this code matches what the server displays.
            </p>
            <div className="approval-spinner" />
            <button onClick={switchToPasswordEntry}>
              Enter Password Instead
            </button>
          </div>
        </div>
      )}

      {needsPasswordInput && !pendingApproval && (
        <div className="overlay">
          <div className="card">
            <h2>Password Required</h2>
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (passwordErrorMessage) {
                  setPasswordErrorMessage("");
                }
              }}
              placeholder="Enter password"
            />
            {passwordErrorMessage && (
              <p className="password-error" data-testid="password-error">
                {passwordErrorMessage}
              </p>
            )}
            <button onClick={submitPassword}>Connect</button>
          </div>
        </div>
      )}

      {!token && (
        <div className="overlay">
          <div className="card">URL missing `token` query parameter.</div>
        </div>
      )}
    </div>
  );
};
