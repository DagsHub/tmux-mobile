import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { RuntimeConfig } from "./config.js";
import type {
  ControlClientMessage,
  ControlServerMessage,
  TmuxSessionSummary,
  TmuxStateSnapshot
} from "./types/protocol.js";
import { randomToken } from "./util/random.js";
import { AuthService } from "./auth/auth-service.js";
import type { TmuxGateway } from "./tmux/types.js";
import { TerminalRuntime } from "./pty/terminal-runtime.js";
import type { PtyFactory } from "./pty/pty-adapter.js";
import { TmuxStateMonitor } from "./state/state-monitor.js";

interface ControlContext {
  socket: WebSocket;
  authed: boolean;
  clientId: string;
  runtime?: TerminalRuntime;
  attachedSession?: string;
  baseSession?: string;
  terminalClients: Set<DataContext>;
}

interface DataContext {
  socket: WebSocket;
  authed: boolean;
  controlClientId?: string;
  controlContext?: ControlContext;
}

interface ReconnectState {
  baseSession?: string;
  paneId?: string;
  zoomed?: boolean;
  updatedAt: number;
}

export interface ServerDependencies {
  tmux: TmuxGateway;
  ptyFactory: PtyFactory;
  authService?: AuthService;
  logger?: Pick<Console, "log" | "error">;
}

export interface RunningServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  server: http.Server;
  config: RuntimeConfig;
}

export const frontendFallbackRoute = "/{*path}";

export const isWebSocketPath = (requestPath: string): boolean => requestPath.startsWith("/ws/");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseClientMessage = (raw: string): ControlClientMessage | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    return parsed as ControlClientMessage;
  } catch {
    return null;
  }
};

const sendJson = (socket: WebSocket, payload: ControlServerMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
};

const MOBILE_SESSION_PREFIX = "tmux-mobile-client-";

const isManagedMobileSession = (name: string): boolean => name.startsWith(MOBILE_SESSION_PREFIX);

const buildMobileSessionName = (clientId: string): string => `${MOBILE_SESSION_PREFIX}${clientId}`;

const normalizeClientId = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) {
    return undefined;
  }
  return trimmed;
};

export const createTmuxMobileServer = (
  config: RuntimeConfig,
  deps: ServerDependencies
): RunningServer => {
  const logger = deps.logger ?? console;
  const authService = deps.authService ?? new AuthService(config.password, config.token);

  const app = express();
  app.use(express.json());

  app.get("/api/config", (_req, res) => {
    res.json({
      passwordRequired: authService.requiresPassword(),
      scrollbackLines: config.scrollbackLines,
      pollIntervalMs: config.pollIntervalMs
    });
  });

  app.use(express.static(config.frontendDir));
  app.get(frontendFallbackRoute, (req, res) => {
    if (isWebSocketPath(req.path)) {
      res.status(404).end();
      return;
    }

    res.sendFile(path.join(config.frontendDir, "index.html"), (error) => {
      if (error) {
        res.status(500).send("Frontend not built. Run npm run build:frontend");
      }
    });
  });

  const server = http.createServer(app);
  const controlWss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });
  const controlClients = new Set<ControlContext>();
  const terminalClients = new Set<DataContext>();
  const reconnectStateByClientId = new Map<string, ReconnectState>();

  let monitor: TmuxStateMonitor | undefined;
  let started = false;
  let stopPromise: Promise<void> | null = null;

  const rememberReconnectState = (
    context: ControlContext,
    patch: Partial<Omit<ReconnectState, "updatedAt">>
  ): void => {
    if (!context.clientId) {
      return;
    }

    const existing = reconnectStateByClientId.get(context.clientId);
    reconnectStateByClientId.set(context.clientId, {
      baseSession: patch.baseSession ?? existing?.baseSession,
      paneId: patch.paneId ?? existing?.paneId,
      zoomed: patch.zoomed ?? existing?.zoomed,
      updatedAt: Date.now()
    });
  };

  const updateReconnectStateFromSnapshot = (
    context: ControlContext,
    state: TmuxStateSnapshot
  ): void => {
    if (!context.authed || !context.attachedSession) {
      return;
    }

    const attachedState = state.sessions.find((session) => session.name === context.attachedSession);
    if (!attachedState) {
      return;
    }
    const activeWindow =
      attachedState.windowStates.find((windowState) => windowState.active) ?? attachedState.windowStates[0];
    const activePane = activeWindow?.panes.find((pane) => pane.active) ?? activeWindow?.panes[0];
    if (!activeWindow || !activePane) {
      return;
    }

    rememberReconnectState(context, {
      baseSession: context.baseSession,
      paneId: activePane.id,
      zoomed: activeWindow.zoomed
    });
  };

  const broadcastState = (state: TmuxStateSnapshot): void => {
    for (const client of controlClients) {
      if (!client.authed) {
        continue;
      }
      sendJson(client.socket, { type: "tmux_state", state });
      updateReconnectStateFromSnapshot(client, state);
    }
  };

  const getControlContext = (clientId: string): ControlContext | undefined =>
    Array.from(controlClients).find((candidate) => candidate.authed && candidate.clientId === clientId);

  const getOrCreateRuntime = (context: ControlContext): TerminalRuntime => {
    if (context.runtime) {
      return context.runtime;
    }

    const runtime = new TerminalRuntime(deps.ptyFactory);
    runtime.on("data", (chunk) => {
      for (const terminalClient of context.terminalClients) {
        if (terminalClient.authed && terminalClient.socket.readyState === terminalClient.socket.OPEN) {
          terminalClient.socket.send(chunk);
        }
      }
    });
    runtime.on("exit", (code) => {
      logger.log(`tmux PTY exited with code ${code} (${context.clientId})`);
      sendJson(context.socket, { type: "info", message: "tmux client exited" });
    });
    context.runtime = runtime;
    return runtime;
  };

  const tryRestoreClientView = async (context: ControlContext): Promise<void> => {
    if (!context.attachedSession) {
      return;
    }

    const reconnectState = reconnectStateByClientId.get(context.clientId);
    if (!reconnectState?.paneId) {
      return;
    }

    try {
      await deps.tmux.selectPane(reconnectState.paneId);
    } catch (error) {
      logger.log("restore pane skipped", context.clientId, reconnectState.paneId, error);
      return;
    }

    if (typeof reconnectState.zoomed !== "boolean") {
      return;
    }

    try {
      const windows = await deps.tmux.listWindows(context.attachedSession);
      const activeWindow = windows.find((windowState) => windowState.active) ?? windows[0];
      if (activeWindow && activeWindow.zoomed !== reconnectState.zoomed) {
        await deps.tmux.zoomPane(reconnectState.paneId);
      }
    } catch (error) {
      logger.log("restore zoom skipped", context.clientId, reconnectState.paneId, error);
    }
  };

  const attachControlToBaseSession = async (
    context: ControlContext,
    baseSession: string
  ): Promise<void> => {
    const runtime = getOrCreateRuntime(context);
    const mobileSession = buildMobileSessionName(context.clientId);
    const sessions = await deps.tmux.listSessions();
    const hasMobileSession = sessions.some((session) => session.name === mobileSession);
    const needsRecreate = hasMobileSession && context.baseSession && context.baseSession !== baseSession;

    if (needsRecreate) {
      await deps.tmux.killSession(mobileSession);
    }
    if (!hasMobileSession || needsRecreate) {
      await deps.tmux.createGroupedSession(mobileSession, baseSession);
    }

    context.baseSession = baseSession;
    context.attachedSession = mobileSession;
    rememberReconnectState(context, { baseSession });
    runtime.attachToSession(mobileSession);
    await tryRestoreClientView(context);
    sendJson(context.socket, { type: "attached", session: mobileSession });
  };

  const ensureAttachedSession = async (
    context: ControlContext,
    forceSession?: string
  ): Promise<void> => {
    if (forceSession) {
      logger.log("attach session (forced)", forceSession);
      await attachControlToBaseSession(context, forceSession);
      return;
    }

    const sessions = (await deps.tmux.listSessions()).filter(
      (session) => !isManagedMobileSession(session.name)
    );
    logger.log(
      "sessions discovered",
      sessions.map((session) => `${session.name}:${session.attached ? "attached" : "detached"}`).join(",")
    );

    const preferredSession = context.baseSession
      ? sessions.find((session) => session.name === context.baseSession)
      : undefined;
    if (preferredSession) {
      logger.log("reattach preferred session", preferredSession.name);
      await attachControlToBaseSession(context, preferredSession.name);
      return;
    }

    if (sessions.length === 0) {
      await deps.tmux.createSession(config.defaultSession);
      logger.log("created default session", config.defaultSession);
      await attachControlToBaseSession(context, config.defaultSession);
      return;
    }

    if (sessions.length === 1) {
      logger.log("attach only session", sessions[0].name);
      await attachControlToBaseSession(context, sessions[0].name);
      return;
    }

    logger.log("show session picker", sessions.length);
    sendJson(context.socket, { type: "session_picker", sessions });
  };

  const runControlMutation = async (
    message: ControlClientMessage,
    context: ControlContext
  ): Promise<void> => {
    const attachedSession = context.attachedSession;
    switch (message.type) {
      case "select_session":
        await attachControlToBaseSession(context, message.session);
        return;
      case "new_session":
        await deps.tmux.createSession(message.name);
        await attachControlToBaseSession(context, message.name);
        return;
      case "new_window":
        if (!attachedSession) {
          throw new Error("no attached session");
        }
        await deps.tmux.newWindow(attachedSession);
        return;
      case "select_window":
        if (!attachedSession) {
          throw new Error("no attached session");
        }
        await deps.tmux.selectWindow(attachedSession, message.windowIndex);
        return;
      case "kill_window":
        if (!attachedSession) {
          throw new Error("no attached session");
        }
        await deps.tmux.killWindow(attachedSession, message.windowIndex);
        return;
      case "select_pane":
        await deps.tmux.selectPane(message.paneId);
        rememberReconnectState(context, { paneId: message.paneId });
        return;
      case "split_pane":
        await deps.tmux.splitWindow(message.paneId, message.orientation);
        return;
      case "kill_pane":
        await deps.tmux.killPane(message.paneId);
        return;
      case "zoom_pane":
        await deps.tmux.zoomPane(message.paneId);
        rememberReconnectState(context, {
          paneId: message.paneId,
          zoomed: !(reconnectStateByClientId.get(context.clientId)?.zoomed ?? false)
        });
        return;
      case "capture_scrollback": {
        const lines = message.lines ?? config.scrollbackLines;
        const output = await deps.tmux.capturePane(message.paneId, lines);
        sendJson(context.socket, {
          type: "scrollback",
          paneId: message.paneId,
          lines,
          text: output
        });
        return;
      }
      case "send_compose":
        context.runtime?.write(`${message.text}\r`);
        return;
      case "auth":
        return;
      default: {
        const _: never = message;
        return _;
      }
    }
  };

  const shutdownControlContext = async (context: ControlContext): Promise<void> => {
    for (const terminalClient of context.terminalClients) {
      if (terminalClient.socket.readyState === terminalClient.socket.OPEN) {
        terminalClient.socket.close();
      }
    }
    context.terminalClients.clear();
    context.runtime?.shutdown();
    context.runtime = undefined;
    if (context.attachedSession) {
      try {
        await deps.tmux.killSession(context.attachedSession);
      } catch (error) {
        logger.error("failed to cleanup mobile session", context.attachedSession, error);
      }
      context.attachedSession = undefined;
    }
  };

  controlWss.on("connection", (socket) => {
    const context: ControlContext = {
      socket,
      authed: false,
      clientId: "",
      terminalClients: new Set<DataContext>()
    };
    controlClients.add(context);
    logger.log("control ws connected");

    socket.on("message", async (rawData) => {
      const message = parseClientMessage(rawData.toString("utf8"));
      if (!message) {
        sendJson(socket, { type: "error", message: "invalid message format" });
        return;
      }
      logger.log("control ws message", context.clientId, message.type);

      try {
        if (!context.authed) {
          if (message.type !== "auth") {
            sendJson(socket, { type: "auth_error", reason: "auth required" });
            return;
          }

          const authResult = authService.verify({
            token: message.token,
            password: message.password
          });
          if (!authResult.ok) {
            logger.log("control ws auth failed", authResult.reason ?? "unknown");
            sendJson(socket, {
              type: "auth_error",
              reason: authResult.reason ?? "unauthorized"
            });
            return;
          }

          const requestedClientId = normalizeClientId(message.clientId);
          if (requestedClientId) {
            const existingContext = Array.from(controlClients).find(
              (candidate) => candidate !== context && candidate.authed && candidate.clientId === requestedClientId
            );
            if (existingContext) {
              controlClients.delete(existingContext);
              await shutdownControlContext(existingContext);
              if (
                existingContext.socket.readyState === existingContext.socket.OPEN ||
                existingContext.socket.readyState === existingContext.socket.CONNECTING
              ) {
                existingContext.socket.close(4000, "reconnected");
              }
            }
          }

          context.clientId = requestedClientId ?? randomToken(12);
          context.baseSession = reconnectStateByClientId.get(context.clientId)?.baseSession;
          context.authed = true;
          logger.log("control ws auth ok", context.clientId);
          sendJson(socket, {
            type: "auth_ok",
            clientId: context.clientId,
            requiresPassword: authService.requiresPassword()
          });
          try {
            await ensureAttachedSession(context);
          } catch (error) {
            logger.error("initial attach failed", error);
            sendJson(socket, {
              type: "error",
              message: error instanceof Error ? error.message : String(error)
            });
          }
          await monitor?.forcePublish();
          return;
        }

        try {
          await runControlMutation(message, context);
        } finally {
          await monitor?.forcePublish();
        }
      } catch (error) {
        logger.error("control ws error", context.clientId, error);
        sendJson(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    socket.on("close", () => {
      rememberReconnectState(context, { baseSession: context.baseSession });
      controlClients.delete(context);
      void shutdownControlContext(context);
      logger.log("control ws closed", context.clientId);
    });
  });

  terminalWss.on("connection", (socket) => {
    const ctx: DataContext = { socket, authed: false };
    terminalClients.add(ctx);
    logger.log("terminal ws connected");

    socket.on("message", (rawData, isBinary) => {
      if (!ctx.authed) {
        if (isBinary) {
          socket.close(4001, "auth required");
          return;
        }

        const authMessage = parseClientMessage(rawData.toString("utf8"));
        if (!authMessage || authMessage.type !== "auth") {
          socket.close(4001, "auth required");
          return;
        }
        const clientId = normalizeClientId(authMessage.clientId);
        if (!clientId) {
          socket.close(4001, "unauthorized");
          return;
        }

        const authResult = authService.verify({
          token: authMessage.token,
          password: authMessage.password
        });
        if (!authResult.ok) {
          logger.log("terminal ws auth failed", authResult.reason ?? "unknown");
          socket.close(4001, "unauthorized");
          return;
        }
        const controlContext = getControlContext(clientId);
        if (!controlContext || !controlContext.authed) {
          socket.close(4001, "unauthorized");
          return;
        }

        ctx.authed = true;
        ctx.controlClientId = clientId;
        ctx.controlContext = controlContext;
        controlContext.terminalClients.add(ctx);
        logger.log("terminal ws auth ok");
        return;
      }

      if (isBinary) {
        ctx.controlContext?.runtime?.write(rawData.toString());
        return;
      }

      const text = rawData.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const payload = JSON.parse(text) as unknown;
          if (
            isObject(payload) &&
            payload.type === "resize" &&
            typeof payload.cols === "number" &&
            typeof payload.rows === "number"
          ) {
            ctx.controlContext?.runtime?.resize(payload.cols, payload.rows);
            return;
          }
        } catch {
          // fall through and treat as terminal input
        }
      }

      ctx.controlContext?.runtime?.write(text);
    });

    socket.on("close", () => {
      terminalClients.delete(ctx);
      ctx.controlContext?.terminalClients.delete(ctx);
      logger.log("terminal ws closed");
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/ws/control") {
      controlWss.handleUpgrade(request, socket, head, (websocket) => {
        controlWss.emit("connection", websocket, request);
      });
      return;
    }

    if (url.pathname === "/ws/terminal") {
      terminalWss.handleUpgrade(request, socket, head, (websocket) => {
        terminalWss.emit("connection", websocket, request);
      });
      return;
    }

    socket.destroy();
  });

  return {
    config,
    server,
    async start() {
      if (started) {
        return;
      }
      logger.log("server start requested", `${config.host}:${config.port}`);
      monitor = new TmuxStateMonitor(
        deps.tmux,
        config.pollIntervalMs,
        broadcastState,
        (error) => logger.error(error)
      );
      await monitor.start();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("error", onError);
          reject(error);
        };

        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          started = true;
          logger.log("server listening", `${config.host}:${(server.address() as { port: number }).port}`);
          resolve();
        });
      });
    },
    async stop() {
      if (!started) {
        return;
      }
      if (stopPromise) {
        await stopPromise;
        return;
      }

      stopPromise = (async () => {
        logger.log("server shutdown begin");
        monitor?.stop();
        await Promise.all(Array.from(controlClients).map((context) => shutdownControlContext(context)));
        controlWss.close();
        terminalWss.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        logger.log("server shutdown complete");
      })();

      try {
        await stopPromise;
      } finally {
        started = false;
        stopPromise = null;
      }
    }
  };
};
