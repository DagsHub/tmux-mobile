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
  frontendDir: process.cwd(),
  approvalEnabled: false,
  jwtLifetimeSecs: 86400
});

describe("tmux mobile server", () => {
  let runningServer: RunningServer;
  let tmux: FakeTmuxGateway;
  let ptyFactory: FakePtyFactory;
  let baseWsUrl: string;

  const authControl = async (
    control: WebSocket,
    token: string = "test-token"
  ): Promise<{ clientId: string; attachedSession: string }> => {
    const authOkPromise = waitForMessage<{ type: string; clientId: string }>(
      control,
      (msg) => msg.type === "auth_ok"
    );
    const attachedPromise = waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached"
    );
    control.send(JSON.stringify({ type: "auth", token }));
    const authOk = await authOkPromise;
    const attached = await attachedPromise;
    return { clientId: authOk.clientId, attachedSession: attached.session };
  };

  const waitForTmuxCall = async (
    predicate: (call: string) => boolean,
    timeoutMs = 1_000
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tmux.calls.some(predicate)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for expected tmux call");
  };

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
    const { attachedSession } = await authControl(control);

    expect(attachedSession).toMatch(/^tmux-mobile-client-/);
    expect(tmux.calls).toContain("createSession:main");
    expect(tmux.calls).toContain(`createGroupedSession:${attachedSession}:main`);
    expect(ptyFactory.lastSpawnedSession).toBe(attachedSession);

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

    expect(attached.session).toMatch(/^tmux-mobile-client-/);
    expect(tmux.calls).toContain(`createGroupedSession:${attached.session}:dev`);
    expect(ptyFactory.lastSpawnedSession).toBe(attached.session);
    expect(tmux.calls.some((call) => call.startsWith("switchClient:"))).toBe(false);
    control.close();
  });

  test("requires terminal auth to bind to an authenticated control client", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);

    const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      terminal.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
    terminal.send(JSON.stringify({ type: "auth", token: "test-token" }));

    await expect(closed).resolves.toMatchObject({ code: 4001, reason: "unauthorized" });
    control.close();
  });

  test("isolates terminal runtime per authenticated control client", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const controlA = await openSocket(`${baseWsUrl}/ws/control`);
    const authA = await authControl(controlA);
    const controlB = await openSocket(`${baseWsUrl}/ws/control`);
    const authB = await authControl(controlB);

    expect(ptyFactory.processes).toHaveLength(2);

    const terminalA = await openSocket(`${baseWsUrl}/ws/terminal`);
    terminalA.send(JSON.stringify({ type: "auth", token: "test-token", clientId: authA.clientId }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const terminalB = await openSocket(`${baseWsUrl}/ws/terminal`);
    terminalB.send(JSON.stringify({ type: "auth", token: "test-token", clientId: authB.clientId }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fromA = new Promise<string>((resolve) => {
      terminalA.once("message", (raw: RawData) => resolve(raw.toString("utf8")));
    });
    ptyFactory.processes[0].emitData("from-a");
    await expect(fromA).resolves.toBe("from-a");

    const fromB = new Promise<string>((resolve) => {
      terminalB.once("message", (raw: RawData) => resolve(raw.toString("utf8")));
    });
    ptyFactory.processes[1].emitData("from-b");
    await expect(fromB).resolves.toBe("from-b");

    terminalA.send("input-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ptyFactory.processes[0].writes).toContain("input-a");
    expect(ptyFactory.processes[1].writes).not.toContain("input-a");

    terminalA.close();
    terminalB.close();
    controlA.close();
    controlB.close();
  });

  test("executes control commands and forwards terminal io", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { clientId, attachedSession } = await authControl(control);
    const snapshot = await buildSnapshot(tmux);
    const attachedState = snapshot.sessions.find((session) => session.name === attachedSession);
    expect(attachedState).toBeDefined();
    const paneId = attachedState?.windowStates[0].panes[0].id ?? "";

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
    terminal.send(JSON.stringify({ type: "auth", token: "test-token", clientId }));
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

  test("select_pane with stickyZoom calls both selectPane and zoomPane", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitForMessage(control, (msg: { type: string }) => msg.type === "attached");

    const snapshot = await buildSnapshot(tmux);
    const paneId = snapshot.sessions[0].windowStates[0].panes[0].id;

    // Split to create a second pane
    control.send(JSON.stringify({ type: "split_pane", paneId, orientation: "h" }));
    await waitForTmuxCall((call) => call === `splitWindow:${paneId}:h`);

    const updatedSnapshot = await buildSnapshot(tmux);
    const secondPaneId = updatedSnapshot.sessions[0].windowStates[0].panes[1].id;

    // Clear calls to isolate the select_pane + stickyZoom behavior
    tmux.calls.length = 0;

    // Select the first pane with stickyZoom enabled
    control.send(JSON.stringify({ type: "select_pane", paneId, stickyZoom: true }));
    await waitForTmuxCall((call) => call === `zoomPane:${paneId}`);

    expect(tmux.calls).toContain(`selectPane:${paneId}`);
    expect(tmux.calls).toContain(`zoomPane:${paneId}`);

    // Clear and verify without stickyZoom
    tmux.calls.length = 0;
    control.send(JSON.stringify({ type: "select_pane", paneId: secondPaneId }));
    await waitForTmuxCall((call) => call === `selectPane:${secondPaneId}`);

    expect(tmux.calls).toContain(`selectPane:${secondPaneId}`);
    expect(tmux.calls).not.toContain(`zoomPane:${secondPaneId}`);

    control.close();
  });

  test("select_pane with stickyZoom does not toggle zoom when window is already zoomed", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitForMessage(control, (msg: { type: string }) => msg.type === "attached");

    const snapshot = await buildSnapshot(tmux);
    const paneId = snapshot.sessions[0].windowStates[0].panes[0].id;

    // Split to create a second pane
    control.send(JSON.stringify({ type: "split_pane", paneId, orientation: "h" }));
    await waitForTmuxCall((call) => call === `splitWindow:${paneId}:h`);

    const updatedSnapshot = await buildSnapshot(tmux);
    const secondPaneId = updatedSnapshot.sessions[0].windowStates[0].panes[1].id;

    // Pre-zoom the window
    control.send(JSON.stringify({ type: "zoom_pane", paneId }));
    await waitForTmuxCall((call) => call === `zoomPane:${paneId}`);

    // Clear calls to isolate stickyZoom select behavior
    tmux.calls.length = 0;

    control.send(JSON.stringify({ type: "select_pane", paneId: secondPaneId, stickyZoom: true }));
    await waitForTmuxCall((call) => call === `selectPane:${secondPaneId}`);

    expect(tmux.calls).toContain(`selectPane:${secondPaneId}`);
    expect(tmux.calls).not.toContain(`zoomPane:${secondPaneId}`);

    control.close();
  });

  test("select_window with stickyZoom zooms the target window active pane", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);

    control.send(JSON.stringify({ type: "new_window", session: attachedSession }));
    await waitForTmuxCall((call) => call === `newWindow:${attachedSession}`);

    tmux.calls.length = 0;

    control.send(JSON.stringify({ type: "select_window", session: attachedSession, windowIndex: 0, stickyZoom: true }));
    await waitForTmuxCall((call) => call === `selectWindow:${attachedSession}:0`);

    expect(tmux.calls).toContain(`selectWindow:${attachedSession}:0`);
    expect(tmux.calls.some((call) => call.startsWith("zoomPane:"))).toBe(true);

    control.close();
  });

  test("stop is idempotent when called repeatedly", async () => {
    await runningServer.stop();
    await runningServer.stop();
  });
});
