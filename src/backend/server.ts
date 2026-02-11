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
}

interface DataContext {
  socket: WebSocket;
  authed: boolean;
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
  app.get("*", (req, res) => {
    if (req.path.startsWith("/ws/")) {
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

  const runtime = new TerminalRuntime(deps.ptyFactory);
  let monitor: TmuxStateMonitor | undefined;

  runtime.on("data", (chunk) => {
    for (const client of terminalClients) {
      if (client.authed && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(chunk);
      }
    }
  });

  runtime.on("exit", (code) => {
    logger.log(`tmux PTY exited with code ${code}`);
    for (const client of controlClients) {
      sendJson(client.socket, { type: "info", message: "tmux client exited" });
    }
  });

  const broadcastState = (state: TmuxStateSnapshot): void => {
    for (const client of controlClients) {
      if (client.authed) {
        sendJson(client.socket, { type: "tmux_state", state });
      }
    }
  };

  const ensureAttachedSession = async (
    socket: WebSocket,
    forceSession?: string
  ): Promise<void> => {
    if (forceSession) {
      runtime.attachToSession(forceSession);
      sendJson(socket, { type: "attached", session: forceSession });
      return;
    }

    const sessions = await deps.tmux.listSessions();
    if (sessions.length === 0) {
      await deps.tmux.createSession(config.defaultSession);
      runtime.attachToSession(config.defaultSession);
      sendJson(socket, { type: "attached", session: config.defaultSession });
      return;
    }

    if (sessions.length === 1) {
      runtime.attachToSession(sessions[0].name);
      sendJson(socket, { type: "attached", session: sessions[0].name });
      return;
    }

    sendJson(socket, { type: "session_picker", sessions });
  };

  const runControlMutation = async (
    message: ControlClientMessage,
    socket: WebSocket
  ): Promise<void> => {
    switch (message.type) {
      case "select_session":
        await deps.tmux.switchClient(message.session);
        runtime.attachToSession(message.session);
        sendJson(socket, { type: "attached", session: message.session });
        return;
      case "new_session":
        await deps.tmux.createSession(message.name);
        await deps.tmux.switchClient(message.name);
        runtime.attachToSession(message.name);
        sendJson(socket, { type: "attached", session: message.name });
        return;
      case "new_window":
        await deps.tmux.newWindow(message.session);
        return;
      case "select_window":
        await deps.tmux.selectWindow(message.session, message.windowIndex);
        return;
      case "kill_window":
        await deps.tmux.killWindow(message.session, message.windowIndex);
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
      case "capture_scrollback": {
        const lines = message.lines ?? config.scrollbackLines;
        const output = await deps.tmux.capturePane(message.paneId, lines);
        sendJson(socket, {
          type: "scrollback",
          paneId: message.paneId,
          lines,
          text: output
        });
        return;
      }
      case "send_compose":
        runtime.write(`${message.text}\r`);
        return;
      case "auth":
        return;
      default: {
        const _: never = message;
        return _;
      }
    }
  };

  controlWss.on("connection", (socket, request) => {
    const context: ControlContext = {
      socket,
      authed: false,
      clientId: randomToken(12)
    };
    controlClients.add(context);

    const url = new URL(request.url ?? "/", "http://localhost");
    const tokenFromQuery = url.searchParams.get("token") ?? undefined;
    const passwordFromQuery = url.searchParams.get("password") ?? undefined;

    socket.on("message", async (rawData) => {
      const message = parseClientMessage(rawData.toString("utf8"));
      if (!message) {
        sendJson(socket, { type: "error", message: "invalid message format" });
        return;
      }

      try {
        if (!context.authed) {
          if (message.type !== "auth") {
            sendJson(socket, { type: "auth_error", reason: "auth required" });
            return;
          }

          const authResult = authService.verify({
            token: message.token ?? tokenFromQuery,
            password: message.password ?? passwordFromQuery
          });
          if (!authResult.ok) {
            sendJson(socket, {
              type: "auth_error",
              reason: authResult.reason ?? "unauthorized"
            });
            return;
          }

          context.authed = true;
          sendJson(socket, {
            type: "auth_ok",
            clientId: context.clientId,
            requiresPassword: authService.requiresPassword()
          });
          await ensureAttachedSession(socket);
          await monitor?.forcePublish();
          return;
        }

        await runControlMutation(message, socket);
        await monitor?.forcePublish();
      } catch (error) {
        sendJson(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    socket.on("close", () => {
      controlClients.delete(context);
    });
  });

  terminalWss.on("connection", (socket, request) => {
    const ctx: DataContext = { socket, authed: false };
    terminalClients.add(ctx);

    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? undefined;
    const password = url.searchParams.get("password") ?? undefined;
    const authResult = authService.verify({ token, password });
    if (!authResult.ok) {
      socket.close(4001, "unauthorized");
      terminalClients.delete(ctx);
      return;
    }

    ctx.authed = true;

    socket.on("message", (rawData, isBinary) => {
      if (!ctx.authed) {
        return;
      }

      if (isBinary) {
        runtime.write(rawData.toString());
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
            runtime.resize(payload.cols, payload.rows);
            return;
          }
        } catch {
          // fall through and treat as terminal input
        }
      }

      runtime.write(text);
    });

    socket.on("close", () => {
      terminalClients.delete(ctx);
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
          resolve();
        });
      });
    },
    async stop() {
      monitor?.stop();
      runtime.shutdown();
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
    }
  };
};
