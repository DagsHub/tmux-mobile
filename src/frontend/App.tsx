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
}

type ModifierKey = "ctrl" | "alt" | "shift" | "meta";
type ModifierMode = "off" | "sticky" | "locked";

const query = new URLSearchParams(window.location.search);
const token = query.get("token") ?? "";

const wsOrigin = (() => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}`;
})();

const getPreferredTerminalFontSize = (): number => {
  return window.matchMedia("(max-width: 768px), (pointer: coarse)").matches ? 12 : 14;
};

const parseMessage = (raw: string): ControlServerMessage | null => {
  try {
    return JSON.parse(raw) as ControlServerMessage;
  } catch {
    return null;
  }
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

  const [snapshot, setSnapshot] = useState<TmuxStateSnapshot>({ sessions: [], capturedAt: "" });
  const [attachedSession, setAttachedSession] = useState<string>("");
  const [sessionChoices, setSessionChoices] = useState<TmuxSessionSummary[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composeEnabled, setComposeEnabled] = useState(true);
  const [composeText, setComposeText] = useState("");

  const [openMenu, setOpenMenu] = useState<{ kind: "session" | "window" | "pane"; id: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ label: string; onConfirm: () => void } | null>(null);

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
      setErrorMessage("control websocket disconnected");
      return;
    }
    setErrorMessage("");
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
      return;
    }
    const output = withModifiers ? applyModifiers(input) : input;
    socket.send(output);
  };

  const sendTerminalResize = (): void => {
    const socket = terminalSocketRef.current;
    const terminal = terminalRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !terminal) {
      return;
    }
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

  const openTerminalSocket = (passwordValue: string): void => {
    terminalSocketRef.current?.close();

    const socket = new WebSocket(`${wsOrigin}/ws/terminal`);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "auth", token, password: passwordValue || undefined }));
      setStatusMessage("terminal connected");
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
      }
      sendTerminalResize();
    };

    socket.onmessage = (event) => {
      terminalRef.current?.write(typeof event.data === "string" ? event.data : "");
    };

    socket.onclose = (event) => {
      if (event.code === 4001) {
        setErrorMessage("terminal authentication failed");
      }
      setStatusMessage("terminal disconnected");
    };
    socket.onerror = () => {
      setErrorMessage("terminal websocket error");
    };

    terminalSocketRef.current = socket;
  };

  const openControlSocket = (passwordValue: string): void => {
    controlSocketRef.current?.close();

    const socket = new WebSocket(`${wsOrigin}/ws/control`);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "auth", token, password: passwordValue || undefined }));
    };

    socket.onmessage = (event) => {
      const message = parseMessage(String(event.data));
      if (!message) {
        return;
      }

      switch (message.type) {
        case "auth_ok":
          setErrorMessage("");
          setPasswordErrorMessage("");
          setAuthReady(true);
          setNeedsPasswordInput(false);
          if (message.requiresPassword && passwordValue) {
            localStorage.setItem("tmux-mobile-password", passwordValue);
          } else {
            localStorage.removeItem("tmux-mobile-password");
          }
          openTerminalSocket(passwordValue);
          return;
        case "auth_error":
          setErrorMessage(message.reason);
          setAuthReady(false);
          const passwordAuthFailed =
            message.reason === "invalid password" || Boolean(serverConfig?.passwordRequired);
          if (passwordAuthFailed) {
            setNeedsPasswordInput(true);
            setPasswordErrorMessage(formatPasswordError(message.reason));
            localStorage.removeItem("tmux-mobile-password");
          }
          return;
        case "attached":
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
          setSessionChoices(message.sessions);
          return;
        case "tmux_state":
          setSnapshot(message.state);
          return;
        case "scrollback":
          setScrollbackText(message.text);
          setScrollbackVisible(true);
          return;
        case "error":
          setErrorMessage(message.message);
          return;
        case "info":
          setStatusMessage(message.message);
          return;
      }
    };

    socket.onclose = () => {
      setAuthReady(false);
    };

    controlSocketRef.current = socket;
  };

  useEffect(() => {
    if (!token) {
      setErrorMessage("Missing token in URL");
      return;
    }

    fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`config request failed: ${response.status}`);
        }
        const config = (await response.json()) as ServerConfig;
        setServerConfig(config);

        if (config.passwordRequired && !password) {
          setNeedsPasswordInput(true);
          setPasswordErrorMessage("");
          return;
        }

        openControlSocket(password);
      })
      .catch((error: Error) => {
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

  const submitPassword = (): void => {
    setPasswordErrorMessage("");
    openControlSocket(password);
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
        {/* Row 1: Esc, Ctrl, Alt, Cmd, Meta, /, @, Hm, ↑, Ed */}
        <div className="toolbar-main">
          <button onClick={() => sendTerminal("\u001b")}>Esc</button>
          <button className={`modifier ${modifiers.ctrl}`} onClick={() => toggleModifier("ctrl")}>Ctrl</button>
          <button className={`modifier ${modifiers.alt}`} onClick={() => toggleModifier("alt")}>Alt</button>
          <button className={`modifier ${modifiers.meta}`} onClick={() => toggleModifier("meta")}>Cmd</button>
          <button onClick={() => sendTerminal("\u001b")}>Meta</button>
          <button onClick={() => sendTerminal("/")}>/</button>
          <button onClick={() => sendTerminal("@")}>@</button>
          <button onClick={() => sendTerminal("\u001b[H")}>Hm</button>
          <button onClick={() => sendTerminal("\u001b[A")}>↑</button>
          <button onClick={() => sendTerminal("\u001b[F")}>Ed</button>
        </div>

        {/* Row 2: ^C, ^B, ^R, Sft, Tab, Enter, ..., ←, ↓, → */}
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
          <button onClick={() => sendTerminal("\u001b[D")}>←</button>
          <button onClick={() => sendTerminal("\u001b[B")}>↓</button>
          <button onClick={() => sendTerminal("\u001b[C")}>→</button>
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
          onClick={() => { setDrawerOpen(false); setOpenMenu(null); }}
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
              {snapshot.sessions.map((session) => {
                const sessionMenuId = `session:${session.name}`;
                const isMenuOpen = openMenu?.kind === "session" && openMenu.id === sessionMenuId;
                return (
                  <li key={session.name}>
                    <div className="drawer-item">
                      <button
                        onClick={() => sendControl({ type: "select_session", session: session.name })}
                        className={session.name === (attachedSession || activeSession?.name) ? "active" : ""}
                      >
                        {session.name} {session.attached ? "*" : ""}
                      </button>
                      <button
                        className="kebab-btn"
                        onClick={() => setOpenMenu(isMenuOpen ? null : { kind: "session", id: sessionMenuId })}
                        aria-label={`Actions for session ${session.name}`}
                      >
                        ⋮
                      </button>
                    </div>
                    {isMenuOpen && (
                      <div className="kebab-dropdown">
                        <button onClick={() => {
                          setOpenMenu(null);
                          const newName = window.prompt("Rename session", session.name);
                          if (newName && newName !== session.name) {
                            sendControl({ type: "rename_session", session: session.name, newName });
                          }
                        }}>Rename</button>
                        <button onClick={() => {
                          setOpenMenu(null);
                          const directory = window.prompt(
                            "Default directory for new panes in this session (leave blank to clear)",
                            ""
                          );
                          if (directory === null) {
                            return;
                          }
                          const normalizedDirectory = directory.trim();
                          sendControl({
                            type: "set_session_default_directory",
                            session: session.name,
                            directory: normalizedDirectory || undefined
                          });
                        }}>Set Default Directory</button>
                        <button onClick={() => {
                          setOpenMenu(null);
                          sendControl({ type: "new_window", session: session.name });
                        }}>New Window</button>
                        <button className="destructive" onClick={() => {
                          setOpenMenu(null);
                          setConfirmAction({
                            label: `Kill session "${session.name}"?`,
                            onConfirm: () => sendControl({ type: "kill_session", session: session.name })
                          });
                        }}>Kill Session</button>
                      </div>
                    )}
                  </li>
                );
              })}
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
                ? activeSession.windowStates.map((windowState, _idx, allWindows) => {
                    const windowMenuId = `window:${activeSession.name}:${windowState.index}`;
                    const isMenuOpen = openMenu?.kind === "window" && openMenu.id === windowMenuId;
                    return (
                      <li key={`${activeSession.name}-${windowState.index}`}>
                        <div className="drawer-item">
                          <button
                            onClick={() =>
                              sendControl({
                                type: "select_window",
                                session: activeSession.name,
                                windowIndex: windowState.index
                              })
                            }
                            className={windowState.active ? "active" : ""}
                          >
                            {windowState.index}: {windowState.name} {windowState.active ? "*" : ""}
                          </button>
                          <button
                            className="kebab-btn"
                            onClick={() => setOpenMenu(isMenuOpen ? null : { kind: "window", id: windowMenuId })}
                            aria-label={`Actions for window ${windowState.index}`}
                          >
                            ⋮
                          </button>
                        </div>
                        {isMenuOpen && (
                          <div className="kebab-dropdown">
                            <button onClick={() => {
                              setOpenMenu(null);
                              const newName = window.prompt("Rename window", windowState.name);
                              if (newName && newName !== windowState.name) {
                                sendControl({ type: "rename_window", session: activeSession.name, windowIndex: windowState.index, newName });
                              }
                            }}>Rename</button>
                            <button onClick={() => {
                              setOpenMenu(null);
                              const directory = window.prompt(
                                "Default directory for new panes in this window (leave blank to clear)",
                                ""
                              );
                              if (directory === null) {
                                return;
                              }
                              const normalizedDirectory = directory.trim();
                              sendControl({
                                type: "set_window_default_directory",
                                session: activeSession.name,
                                windowIndex: windowState.index,
                                directory: normalizedDirectory || undefined
                              });
                            }}>Set Default Directory</button>
                            <button onClick={() => {
                              setOpenMenu(null);
                              sendControl({ type: "split_pane", paneId: windowState.panes[0]?.id ?? "", orientation: "h" });
                            }}>Split Horizontal</button>
                            <button onClick={() => {
                              setOpenMenu(null);
                              sendControl({ type: "split_pane", paneId: windowState.panes[0]?.id ?? "", orientation: "v" });
                            }}>Split Vertical</button>
                            {windowState.index > 0 && (
                              <button onClick={() => {
                                setOpenMenu(null);
                                sendControl({ type: "swap_window", session: activeSession.name, srcIndex: windowState.index, dstIndex: windowState.index - 1 });
                              }}>Move Up</button>
                            )}
                            {windowState.index < allWindows[allWindows.length - 1].index && (
                              <button onClick={() => {
                                setOpenMenu(null);
                                const nextWindow = allWindows.find((w) => w.index > windowState.index);
                                if (nextWindow) {
                                  sendControl({ type: "swap_window", session: activeSession.name, srcIndex: windowState.index, dstIndex: nextWindow.index });
                                }
                              }}>Move Down</button>
                            )}
                            <button className="destructive" onClick={() => {
                              setOpenMenu(null);
                              setConfirmAction({
                                label: `Kill window ${windowState.index}: ${windowState.name}?`,
                                onConfirm: () => sendControl({ type: "kill_window", session: activeSession.name, windowIndex: windowState.index })
                              });
                            }}>Kill Window</button>
                          </div>
                        )}
                      </li>
                    );
                  })
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
                ? activeWindow.panes.map((pane) => {
                    const paneMenuId = `pane:${pane.id}`;
                    const isMenuOpen = openMenu?.kind === "pane" && openMenu.id === paneMenuId;
                    return (
                      <li key={pane.id}>
                        <div className="drawer-item">
                          <button
                            onClick={() => sendControl({ type: "select_pane", paneId: pane.id })}
                            className={pane.active ? "active" : ""}
                          >
                            %{pane.index}: {pane.currentCommand} {pane.active ? "*" : ""}
                          </button>
                          <button
                            className="kebab-btn"
                            onClick={() => setOpenMenu(isMenuOpen ? null : { kind: "pane", id: paneMenuId })}
                            aria-label={`Actions for pane ${pane.index}`}
                          >
                            ⋮
                          </button>
                        </div>
                        {isMenuOpen && (
                          <div className="kebab-dropdown">
                            {activeWindow.paneCount > 1 && (
                              <button onClick={() => {
                                setOpenMenu(null);
                                sendControl({ type: "zoom_pane", paneId: pane.id });
                              }}>Zoom</button>
                            )}
                            <button onClick={() => {
                              setOpenMenu(null);
                              sendControl({ type: "split_pane", paneId: pane.id, orientation: "h" });
                            }}>Split Horizontal</button>
                            <button onClick={() => {
                              setOpenMenu(null);
                              sendControl({ type: "split_pane", paneId: pane.id, orientation: "v" });
                            }}>Split Vertical</button>
                            <button onClick={() => {
                              setOpenMenu(null);
                              sendControl({ type: "break_pane", paneId: pane.id });
                            }}>Break to Window</button>
                            <button className="destructive" onClick={() => {
                              setOpenMenu(null);
                              setConfirmAction({
                                label: `Respawn pane %${pane.index}? This will kill the running process.`,
                                onConfirm: () => sendControl({ type: "respawn_pane", paneId: pane.id })
                              });
                            }}>Respawn Pane</button>
                            <button className="destructive" onClick={() => {
                              setOpenMenu(null);
                              setConfirmAction({
                                label: `Kill pane %${pane.index}?`,
                                onConfirm: () => sendControl({ type: "kill_pane", paneId: pane.id })
                              });
                            }}>Kill Pane</button>
                          </div>
                        )}
                      </li>
                    );
                  })
                : null}
            </ul>

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

      {confirmAction && (
        <div className="overlay" data-testid="confirm-overlay">
          <div className="card confirm-card">
            <p>{confirmAction.label}</p>
            <div className="confirm-actions">
              <button onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                className="destructive"
                onClick={() => {
                  confirmAction.onConfirm();
                  setConfirmAction(null);
                }}
              >
                Confirm
              </button>
            </div>
          </div>
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

      {needsPasswordInput && (
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
