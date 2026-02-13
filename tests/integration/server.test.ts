import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import { createTmuxMobileServer, type RunningServer } from "../../src/backend/server.js";
import { buildSnapshot } from "../../src/backend/tmux/types.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeTmuxGateway } from "../harness/fakeTmux.js";
import { openSocket, waitForMessage } from "../harness/ws.js";

const buildConfig = (token: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: undefined,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 1000,
  pollIntervalMs: 100,
  token,
  frontendDir: process.cwd()
});

describe("tmux mobile server", () => {
  let runningServer: RunningServer;
  let tmux: FakeTmuxGateway;
  let ptyFactory: FakePtyFactory;
  let baseWsUrl: string;

  const startWithSessions = async (
    sessions: string[],
    options: { password?: string; attachedSession?: string; failSwitchClient?: boolean } = {}
  ): Promise<void> => {
    tmux = new FakeTmuxGateway(sessions, {
      attachedSession: options.attachedSession,
      failSwitchClient: options.failSwitchClient
    });
    ptyFactory = new FakePtyFactory();
    const auth = new AuthService(options.password, "test-token");

    runningServer = createTmuxMobileServer(buildConfig("test-token"), {
      tmux,
      ptyFactory,
      authService: auth,
      logger: { log: () => undefined, error: () => undefined }
    });

    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  };

  beforeEach(async () => {
    await startWithSessions([]);
  });

  afterEach(async () => {
    await runningServer.stop();
  });

  test("rejects invalid token", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "bad-token" }));

    const response = await waitForMessage<{ type: string; reason?: string }>(
      control,
      (msg) => msg.type === "auth_error"
    );
    expect(response.reason).toContain("invalid token");

    control.close();
  });

  test("creates default session and attaches when no sessions exist", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const attached = await waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached"
    );

    expect(attached.session).toBe("main");
    expect(tmux.calls).toContain("createSession:main");
    expect(ptyFactory.lastSpawnedSession).toBe("main");

    control.close();
  });

  test("shows session picker when multiple sessions exist", async () => {
    await runningServer.stop();
    await startWithSessions(["work", "dev"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const picker = await waitForMessage<{ type: string; sessions: Array<{ name: string }> }>(
      control,
      (msg) => msg.type === "session_picker"
    );

    expect(picker.sessions).toHaveLength(2);
    control.close();
  });

  test("shows session picker even when one session is currently attached", async () => {
    await runningServer.stop();
    await startWithSessions(["main", "work"], { attachedSession: "work" });

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const picker = await waitForMessage<{ type: string; sessions: Array<{ name: string }> }>(
      control,
      (msg) => msg.type === "session_picker"
    );

    expect(picker.sessions).toHaveLength(2);
    expect(ptyFactory.lastSpawnedSession).toBeUndefined();
    control.close();
  });

  test("select_session attaches without using switch-client", async () => {
    await runningServer.stop();
    await startWithSessions(["work", "dev"], { failSwitchClient: true });

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitForMessage(control, (msg: { type: string }) => msg.type === "session_picker");

    control.send(JSON.stringify({ type: "select_session", session: "dev" }));
    const attached = await waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached"
    );

    expect(attached.session).toBe("dev");
    expect(ptyFactory.lastSpawnedSession).toBe("dev");
    expect(tmux.calls.some((call) => call.startsWith("switchClient:"))).toBe(false);
    control.close();
  });

  test("executes control commands and forwards terminal io", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    await waitForMessage(control, (msg: { type: string }) => msg.type === "attached");
    const snapshot = await buildSnapshot(tmux);
    const paneId = snapshot.sessions[0].windowStates[0].panes[0].id;

    control.send(JSON.stringify({ type: "split_pane", paneId, orientation: "h" }));
    control.send(JSON.stringify({ type: "send_compose", text: "echo hi" }));
    const capturePromise = waitForMessage<{ type: string; text: string }>(
      control,
      (msg) => msg.type === "scrollback"
    );
    control.send(JSON.stringify({ type: "capture_scrollback", paneId, lines: 222 }));

    const capture = await capturePromise;
    expect(capture.text).toContain("captured 222 lines");
    expect(tmux.calls).toContain(`splitWindow:${paneId}:h`);
    expect(ptyFactory.latestProcess().writes).toContain("echo hi\r");

    const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
    terminal.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const terminalDataPromise = new Promise<string>((resolve) => {
      terminal.once("message", (raw: RawData) => resolve(raw.toString("utf8")));
    });
    ptyFactory.latestProcess().emitData("tmux-output");
    const terminalData = await terminalDataPromise;
    expect(terminalData).toBe("tmux-output");

    terminal.send("input-data");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ptyFactory.latestProcess().writes).toContain("input-data");

    terminal.close();
    control.close();
  });

  test("stop is idempotent when called repeatedly", async () => {
    await runningServer.stop();
    await runningServer.stop();
  });
});
