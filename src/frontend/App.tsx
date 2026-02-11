import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

type ModifierKey = "ctrl" | "alt" | "shift";
type ModifierMode = "off" | "sticky" | "locked";

const query = new URLSearchParams(window.location.search);
const token = query.get("token") ?? "";

const wsOrigin = (() => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}`;
})();

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
  const [authReady, setAuthReady] = useState(false);

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
    shift: "off"
  });
  const modifierTapRef = useRef<{ key: ModifierKey; at: number } | null>(null);

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
      shift: previous.shift === "sticky" ? "off" : previous.shift
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

    if (modifiers.alt !== "off") {
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

  const openTerminalSocket = (passwordValue: string): void => {
    terminalSocketRef.current?.close();

    const url = new URL(`${wsOrigin}/ws/terminal`);
    url.searchParams.set("token", token);
    if (passwordValue) {
      url.searchParams.set("password", passwordValue);
    }

    const socket = new WebSocket(url);
    socket.onopen = () => {
      setStatusMessage("terminal connected");
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminalRef.current.cols,
            rows: terminalRef.current.rows
          })
        );
      }
    };

    socket.onmessage = (event) => {
      terminalRef.current?.write(typeof event.data === "string" ? event.data : "");
    };

    socket.onclose = () => {
      setStatusMessage("terminal disconnected");
    };
    socket.onerror = () => {
      setErrorMessage("terminal websocket error");
    };

    terminalSocketRef.current = socket;
  };

  const openControlSocket = (passwordValue: string): void => {
    controlSocketRef.current?.close();

    const url = new URL(`${wsOrigin}/ws/control`);
    url.searchParams.set("token", token);
    if (passwordValue) {
      url.searchParams.set("password", passwordValue);
    }

    const socket = new WebSocket(url);

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
          setAuthReady(true);
          setNeedsPasswordInput(false);
          openTerminalSocket(passwordValue);
          return;
        case "auth_error":
          setErrorMessage(message.reason);
          setAuthReady(false);
          if (serverConfig?.passwordRequired) {
            setNeedsPasswordInput(true);
          }
          return;
        case "attached":
          setAttachedSession(message.session);
          setSessionChoices(null);
          setDrawerOpen(false);
          setStatusMessage(`attached: ${message.session}`);
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
          return;
        }

        openControlSocket(password);
      })
      .catch((error: Error) => {
        setErrorMessage(error.message);
      });
  }, []);

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: 14,
      theme: {
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

    const onResize = () => {
      fitAddon.fit();
      if (terminalSocketRef.current?.readyState === WebSocket.OPEN) {
        terminalSocketRef.current.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows
          })
        );
      }
    };

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
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

  const submitPassword = (): void => {
    localStorage.setItem("tmux-mobile-password", password);
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
        <div className="top-title">Session: {attachedSession || activeSession?.name || "-"}</div>
        <div className="top-actions">
          <button className="top-btn" onClick={() => requestScrollback(serverConfig?.scrollbackLines ?? 1000)}>
            Scroll
          </button>
          <button className="top-btn" onClick={() => setComposeEnabled((value) => !value)}>
            {composeEnabled ? "Compose On" : "Compose Off"}
          </button>
        </div>
      </header>

      <main className="terminal-wrap">
        <div className="terminal-host" ref={terminalContainerRef} data-testid="terminal-host" />
      </main>

      <section className="toolbar">
        <div className="toolbar-row">
          <button onClick={() => sendTerminal("\u001b")}>Esc</button>
          <button onClick={() => sendTerminal("1")}>1</button>
          <button onClick={() => sendTerminal("2")}>2</button>
          <button onClick={() => sendTerminal("3")}>3</button>
          <button onClick={() => sendTerminal("\t")}>Tab</button>
          <button onClick={() => sendTerminal("/")}>/</button>
          <button onClick={() => sendTerminal("\u001b[3~")}>Del</button>
          <button onClick={() => sendTerminal("\u007f")}>BS</button>
          <button onClick={() => sendTerminal("\u001b[H")}>Hm</button>
          <button onClick={() => sendTerminal("\u001b[A")}>Up</button>
          <button onClick={() => sendTerminal("\u001b[F")}>Ed</button>
          <button onClick={() => sendTerminal("\r")}>Enter</button>
        </div>
        <div className="toolbar-row">
          <button className={`modifier ${modifiers.ctrl}`} onClick={() => toggleModifier("ctrl")}>Ctrl</button>
          <button className={`modifier ${modifiers.alt}`} onClick={() => toggleModifier("alt")}>Alt</button>
          <button className={`modifier ${modifiers.shift}`} onClick={() => toggleModifier("shift")}>Sft</button>
          <button onClick={() => sendTerminal("\u0004", false)}>^D</button>
          <button className="danger" onClick={() => sendTerminal("\u0003", false)}>^C</button>
          <button onClick={() => sendTerminal("\u000c", false)}>^L</button>
          <button onClick={() => sendTerminal("\u0012", false)}>^R</button>
          <button
            onClick={async () => {
              const clip = await navigator.clipboard.readText();
              sendTerminal(clip, false);
            }}
          >
            Paste
          </button>
          <button onClick={() => sendTerminal("\u001b[D")}>Left</button>
          <button onClick={() => sendTerminal("\u001b[B")}>Down</button>
          <button onClick={() => sendTerminal("\u001b[C")}>Right</button>
        </div>
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
            >
              Close
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
                        onClick={() => sendControl({ type: "select_pane", paneId: pane.id })}
                        className={pane.active ? "active" : ""}
                      >
                        %{pane.index}: {pane.currentCommand} {pane.active ? "*" : ""}
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

      {needsPasswordInput && (
        <div className="overlay">
          <div className="card">
            <h2>Password Required</h2>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
            />
            <button onClick={submitPassword}>Connect</button>
          </div>
        </div>
      )}

      {!token && (
        <div className="overlay">
          <div className="card">URL missing `token` query parameter.</div>
        </div>
      )}

      {errorMessage && <div className="status error">{errorMessage}</div>}
      {statusMessage && <div className="status info">{statusMessage}</div>}
      {authReady && <div className="status ok">Connected</div>}
    </div>
  );
};
