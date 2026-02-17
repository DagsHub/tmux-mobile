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
import type { ApprovalService } from "./auth/approval-service.js";
import { resolveGeo } from "./util/geoip.js";
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
  pendingApprovalId?: string;
}

interface DataContext {
  socket: WebSocket;
  authed: boolean;
  controlClientId?: string;
  controlContext?: ControlContext;
  authInProgress: boolean;
}

export interface ServerDependencies {
  tmux: TmuxGateway;
  ptyFactory: PtyFactory;
  authService?: AuthService;
  approvalService?: ApprovalService;
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

export const createTmuxMobileServer = (
  config: RuntimeConfig,
  deps: ServerDependencies
): RunningServer => {
  const logger = deps.logger ?? console;
  const authService = deps.authService ?? new AuthService(config.password, config.token);
  const approvalService = deps.approvalService;

  const app = express();
  app.use(express.json());

  app.get("/api/config", (_req, res) => {
    res.json({
      passwordRequired: authService.requiresPassword(),
      scrollbackLines: config.scrollbackLines,
      pollIntervalMs: config.pollIntervalMs,
      approvalEnabled: config.approvalEnabled
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

  let monitor: TmuxStateMonitor | undefined;
  let started = false;
  let stopPromise: Promise<void> | null = null;

  const broadcastState = (state: TmuxStateSnapshot): void => {
    for (const client of controlClients) {
      if (client.authed) {
        sendJson(client.socket, { type: "tmux_state", state });
      }
    }
  };

  const getControlContext = (clientId: string): ControlContext | undefined =>
    Array.from(controlClients).find((candidate) => candidate.clientId === clientId);

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
    runtime.attachToSession(mobileSession);
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

  const completeAuth = async (context: ControlContext, jwt?: string): Promise<void> => {
    context.authed = true;
    logger.log("control ws auth ok", context.clientId);

    if (jwt) {
      sendJson(context.socket, {
        type: "auth_approved",
        jwt,
        clientId: context.clientId
      });
    } else {
      sendJson(context.socket, {
        type: "auth_ok",
        clientId: context.clientId,
        requiresPassword: authService.requiresPassword()
      });
    }

    try {
      await ensureAttachedSession(context);
    } catch (error) {
      logger.error("initial attach failed", error);
      sendJson(context.socket, {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    await monitor?.forcePublish();
  };

  // Listen for approval/denial events from the TUI
  if (approvalService) {
    approvalService.on("approved", (event: { connectionId: string; jwt: string; clientId: string }) => {
      for (const client of controlClients) {
        if (client.pendingApprovalId === event.connectionId) {
          client.pendingApprovalId = undefined;
          void completeAuth(client, event.jwt);
          break;
        }
      }
    });

    approvalService.on("denied", (event: { connectionId: string }) => {
      for (const client of controlClients) {
        if (client.pendingApprovalId === event.connectionId) {
          client.pendingApprovalId = undefined;
          sendJson(client.socket, { type: "auth_denied", reason: "connection denied by server operator" });
          break;
        }
      }
    });
  }

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
        return;
      case "split_pane":
        await deps.tmux.splitWindow(message.paneId, message.orientation);
        return;
      case "kill_pane":
        await deps.tmux.killPane(message.paneId);
        return;
      case "zoom_pane":
        await deps.tmux.zoomPane(message.paneId);
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

  controlWss.on("connection", (socket, request) => {
    const context: ControlContext = {
      socket,
      authed: false,
      clientId: randomToken(12),
      terminalClients: new Set<DataContext>()
    };
    controlClients.add(context);
    logger.log("control ws connected", context.clientId);

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

          // 1. JWT authentication (if approvalService available and JWT provided)
          if (message.jwt && approvalService) {
            const jwtResult = await approvalService.verifyJwt(message.jwt);
            if (jwtResult.valid) {
              logger.log("control ws jwt auth ok", context.clientId);
              const freshJwt = await approvalService.signJwt(context.clientId);
              await completeAuth(context, freshJwt);
              return;
            }
            logger.log("control ws jwt invalid", context.clientId, jwtResult.reason);
            // JWT invalid — fall through to password check
          }

          // 2. Normal password/token verification
          const authResult = authService.verify({
            token: message.token,
            password: message.password
          });

          if (authResult.ok) {
            // Password matched (or no password required) — issue JWT if approvalService exists
            if (approvalService) {
              const jwt = await approvalService.signJwt(context.clientId);
              logger.log("control ws auth ok (issuing jwt)", context.clientId);
              await completeAuth(context, jwt);
            } else {
              await completeAuth(context);
            }
            return;
          }

          // 3. Invalid password + approval service → enter pending approval
          if (authResult.reason === "invalid password" && approvalService) {
            const ip = (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
              ?? request.socket.remoteAddress
              ?? "unknown";
            const userAgent = request.headers["user-agent"] ?? "unknown";
            const geoLocation = resolveGeo(ip);

            const pending = approvalService.addPending({
              clientId: context.clientId,
              socket,
              ip,
              userAgent,
              geoLocation
            });
            context.pendingApprovalId = pending.id;
            logger.log("control ws pending approval", context.clientId, pending.challengeCode);
            sendJson(socket, { type: "auth_pending", challengeCode: pending.challengeCode });
            return;
          }

          // 4. Normal auth failure
          logger.log("control ws auth failed", context.clientId, authResult.reason ?? "unknown");
          sendJson(socket, {
            type: "auth_error",
            reason: authResult.reason ?? "unauthorized"
          });
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
      if (context.pendingApprovalId && approvalService) {
        approvalService.removePending(context.pendingApprovalId);
      }
      controlClients.delete(context);
      void shutdownControlContext(context);
      logger.log("control ws closed", context.clientId);
    });
  });

  terminalWss.on("connection", (socket, request) => {
    const ctx: DataContext = { socket, authed: false, authInProgress: false };
    terminalClients.add(ctx);
    logger.log("terminal ws connected");

    socket.on("message", async (rawData, isBinary) => {
      if (!ctx.authed) {
        // Ignore messages while async auth (JWT verification) is in progress
        if (ctx.authInProgress) {
          return;
        }

        if (isBinary) {
          socket.close(4001, "auth required");
          return;
        }

        const authMessage = parseClientMessage(rawData.toString("utf8"));
        if (!authMessage || authMessage.type !== "auth") {
          socket.close(4001, "auth required");
          return;
        }
        const clientId = authMessage.clientId;
        if (!clientId) {
          socket.close(4001, "unauthorized");
          return;
        }

        // JWT verification path for terminal WS
        if (authMessage.jwt && approvalService) {
          ctx.authInProgress = true;
          const jwtResult = await approvalService.verifyJwt(authMessage.jwt);
          ctx.authInProgress = false;
          if (jwtResult.valid) {
            ctx.authed = true;
            logger.log("terminal ws jwt auth ok");
            return;
          }
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
