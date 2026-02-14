import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ApprovalService } from "../../src/backend/auth/approval-service.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import { createTmuxMobileServer, type RunningServer } from "../../src/backend/server.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeTmuxGateway } from "../harness/fakeTmux.js";
import { openSocket } from "../harness/ws.js";

const silentLogger = { log: () => undefined, error: () => undefined };

const buildConfig = (
  token: string,
  options: { password?: string; approvalEnabled?: boolean } = {}
): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: options.password,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 1000,
  pollIntervalMs: 100,
  token,
  frontendDir: process.cwd(),
  approvalEnabled: options.approvalEnabled ?? true,
  jwtLifetimeSecs: 3600
});

/**
 * Collects all messages from a WebSocket into an array.
 * Messages can be queried later even if they arrived before a listener was set up.
 */
const collectMessages = (socket: WebSocket): { messages: Array<Record<string, unknown>>; waitFor: (matcher: (msg: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>> } => {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{ matcher: (msg: Record<string, unknown>) => boolean; resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }> = [];

  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    messages.push(msg);

    // Check if any waiter matches
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].matcher(msg)) {
        const waiter = waiters.splice(i, 1)[0];
        waiter.resolve(msg);
      }
    }
  });

  const waitFor = (matcher: (msg: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> => {
    // Check already-received messages first
    const existing = messages.find(matcher);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for message. Received: ${JSON.stringify(messages.map((m) => m.type))}`));
      }, timeoutMs);

      waiters.push({
        matcher,
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject
      });
    });
  };

  return { messages, waitFor };
};

describe("approval flow integration", () => {
  let runningServer: RunningServer;
  let tmux: FakeTmuxGateway;
  let ptyFactory: FakePtyFactory;
  let approvalService: ApprovalService;
  let baseWsUrl: string;

  const startServer = async (options: {
    sessions?: string[];
    password?: string;
    approvalEnabled?: boolean;
  } = {}): Promise<void> => {
    tmux = new FakeTmuxGateway(options.sessions ?? ["main"]);
    ptyFactory = new FakePtyFactory();
    const auth = new AuthService(options.password, "test-token");
    const jwtSecret = crypto.randomBytes(32);
    approvalService = new ApprovalService({ jwtSecret, jwtLifetimeSecs: 3600 });

    const config = buildConfig("test-token", {
      password: options.password,
      approvalEnabled: options.approvalEnabled
    });

    runningServer = createTmuxMobileServer(config, {
      tmux,
      ptyFactory,
      authService: auth,
      approvalService: options.approvalEnabled !== false ? approvalService : undefined,
      logger: silentLogger
    });

    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  };

  beforeEach(async () => {
    await startServer({ password: "secret123" });
  });

  afterEach(async () => {
    await runningServer.stop();
  });

  test("password auth succeeds and issues JWT via auth_approved", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token", password: "secret123" }));

    const response = await waitFor((msg) => msg.type === "auth_approved") as { type: string; jwt?: string; clientId?: string };

    expect(response.jwt).toBeTruthy();
    expect(response.clientId).toBeTruthy();

    // Verify the JWT is valid
    const verification = await approvalService.verifyJwt(response.jwt!);
    expect(verification.valid).toBe(true);

    // Should also get attached message
    const attached = await waitFor((msg) => msg.type === "attached") as { type: string; session: string };
    expect(attached.session).toBe("main");

    control.close();
  });

  test("passwordless connection enters pending approval state", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const response = await waitFor((msg) => msg.type === "auth_pending") as { type: string; challengeCode?: string };

    expect(response.challengeCode).toBeTruthy();
    expect(response.challengeCode).toHaveLength(4);

    // Verify pending list has the connection
    expect(approvalService.getPending()).toHaveLength(1);
    expect(approvalService.getPending()[0].challengeCode).toBe(response.challengeCode);

    control.close();
  });

  test("approving a pending connection sends auth_approved with JWT", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitFor((msg) => msg.type === "auth_pending");

    const pending = approvalService.getPending();
    expect(pending).toHaveLength(1);

    // Approve the connection from the server side
    await approvalService.approve(pending[0].id);

    const approved = await waitFor((msg) => msg.type === "auth_approved") as { type: string; jwt?: string; clientId?: string };

    expect(approved.jwt).toBeTruthy();
    expect(approved.clientId).toBeTruthy();

    // Should proceed to session attachment
    const attached = await waitFor((msg) => msg.type === "attached") as { type: string; session: string };
    expect(attached.session).toBe("main");

    control.close();
  });

  test("denying a pending connection sends auth_denied", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitFor((msg) => msg.type === "auth_pending");

    const pending = approvalService.getPending();

    approvalService.deny(pending[0].id);

    const denied = await waitFor((msg) => msg.type === "auth_denied") as { type: string; reason?: string };

    expect(denied.reason).toContain("denied");
    control.close();
  });

  test("JWT reconnection skips password and approval", async () => {
    // First: get a JWT via password auth
    const control1 = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor: waitFor1 } = collectMessages(control1);

    control1.send(JSON.stringify({ type: "auth", token: "test-token", password: "secret123" }));

    const firstAuth = await waitFor1((msg) => msg.type === "auth_approved") as { type: string; jwt?: string };
    const jwt = firstAuth.jwt!;
    control1.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second: reconnect with just the JWT
    const control2 = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor: waitFor2 } = collectMessages(control2);

    control2.send(JSON.stringify({ type: "auth", token: "test-token", jwt }));

    // Should get auth_ok (not auth_pending, not auth_approved)
    const reconnected = await waitFor2((msg) => msg.type === "auth_ok") as { type: string; clientId?: string };
    expect(reconnected.clientId).toBeTruthy();

    // Should also attach to session
    const attached = await waitFor2((msg) => msg.type === "attached") as { type: string; session: string };
    expect(attached.session).toBe("main");

    // No pending connections should exist
    expect(approvalService.getPending()).toHaveLength(0);

    control2.close();
  });

  test("invalid JWT falls through to password check", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({
      type: "auth",
      token: "test-token",
      jwt: "invalid.jwt.token",
      password: "secret123"
    }));

    const response = await waitFor((msg) => msg.type === "auth_approved") as { type: string; jwt?: string };
    expect(response.jwt).toBeTruthy();

    control.close();
  });

  test("invalid JWT without password enters pending approval", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({
      type: "auth",
      token: "test-token",
      jwt: "invalid.jwt.token"
    }));

    const response = await waitFor((msg) => msg.type === "auth_pending") as { type: string; challengeCode?: string };
    expect(response.challengeCode).toBeTruthy();

    control.close();
  });

  test("socket close removes pending connection", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitFor((msg) => msg.type === "auth_pending");
    expect(approvalService.getPending()).toHaveLength(1);

    control.close();
    // Wait for close to propagate
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(approvalService.getPending()).toHaveLength(0);
  });

  test("terminal WS authenticates with JWT", async () => {
    // Get a JWT first
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token", password: "secret123" }));
    const authResponse = await waitFor((msg) => msg.type === "auth_approved") as { type: string; jwt?: string };
    const jwt = authResponse.jwt!;

    // Now connect terminal WS with the JWT
    const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
    terminal.send(JSON.stringify({ type: "auth", token: "test-token", jwt }));

    // Wait for auth to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    // If auth succeeded, the terminal should stay open and accept data
    expect(terminal.readyState).toBe(WebSocket.OPEN);

    terminal.close();
    control.close();
  });

  test("terminal WS rejects invalid JWT and falls back to password check", async () => {
    const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
    const closePromise = new Promise<number>((resolve) => {
      terminal.on("close", (code) => resolve(code));
    });
    terminal.send(JSON.stringify({
      type: "auth",
      token: "test-token",
      jwt: "bad.jwt.token"
    }));

    const code = await closePromise;
    expect(code).toBe(4001);
  });

  test("multiple pending connections are tracked independently", async () => {
    const control1 = await openSocket(`${baseWsUrl}/ws/control`);
    const control2 = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor: waitFor1 } = collectMessages(control1);
    const { waitFor: waitFor2 } = collectMessages(control2);

    control1.send(JSON.stringify({ type: "auth", token: "test-token" }));
    control2.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const pending1 = await waitFor1((msg) => msg.type === "auth_pending") as { type: string; challengeCode: string };
    const pending2 = await waitFor2((msg) => msg.type === "auth_pending") as { type: string; challengeCode: string };

    expect(approvalService.getPending()).toHaveLength(2);
    expect(pending1.challengeCode).toBeTruthy();
    expect(pending2.challengeCode).toBeTruthy();

    // Approve only the first
    const pendingList = approvalService.getPending();
    await approvalService.approve(pendingList[0].id);

    const approved = await waitFor1((msg) => msg.type === "auth_approved") as { type: string };
    expect(approved.type).toBe("auth_approved");

    // Second should still be pending
    expect(approvalService.getPending()).toHaveLength(1);

    control1.close();
    control2.close();
  });

  test("/api/config includes approvalEnabled flag", async () => {
    const address = runningServer.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config`);
    const config = await response.json() as { approvalEnabled: boolean };
    expect(config.approvalEnabled).toBe(true);
  });
});

describe("approval disabled (--no-approve)", () => {
  let runningServer: RunningServer;
  let baseWsUrl: string;

  beforeEach(async () => {
    const tmux = new FakeTmuxGateway(["main"]);
    const ptyFactory = new FakePtyFactory();
    const auth = new AuthService("secret123", "test-token");

    const config = buildConfig("test-token", {
      password: "secret123",
      approvalEnabled: false
    });

    runningServer = createTmuxMobileServer(config, {
      tmux,
      ptyFactory,
      authService: auth,
      // No approvalService passed — simulates --no-approve
      logger: silentLogger
    });

    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await runningServer.stop();
  });

  test("passwordless connection is rejected with auth_error", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const response = await waitFor((msg) => msg.type === "auth_error") as { type: string; reason?: string };
    expect(response.reason).toContain("invalid password");

    control.close();
  });

  test("password auth succeeds with auth_ok (no JWT issued)", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { waitFor } = collectMessages(control);

    control.send(JSON.stringify({ type: "auth", token: "test-token", password: "secret123" }));

    const response = await waitFor((msg) => msg.type === "auth_ok") as { type: string; clientId?: string };
    expect(response.clientId).toBeTruthy();

    control.close();
  });

  test("/api/config shows approvalEnabled false", async () => {
    const address = runningServer.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config`);
    const config = await response.json() as { approvalEnabled: boolean };
    expect(config.approvalEnabled).toBe(false);
  });
});
