import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import { createTmuxMobileServer, type RunningServer } from "../../src/backend/server.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeTmuxGateway } from "../harness/fakeTmux.js";

const buildConfig = (frontendDir: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: undefined,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 1000,
  pollIntervalMs: 100,
  token: "test-token",
  frontendDir
});

describe("frontend route handling", () => {
  let runningServer: RunningServer | undefined;
  let baseUrl: string;

  const startServer = async (frontendDir: string): Promise<void> => {
    const tmux = new FakeTmuxGateway([]);
    const ptyFactory = new FakePtyFactory();
    const auth = new AuthService(undefined, "test-token");

    runningServer = createTmuxMobileServer(buildConfig(frontendDir), {
      tmux,
      ptyFactory,
      authService: auth,
      logger: { log: () => undefined, error: () => undefined }
    });

    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  afterEach(async () => {
    if (runningServer) {
      await runningServer.stop();
      runningServer = undefined;
    }
  });

  test("fallback route returns 404 for WebSocket paths", async () => {
    await startServer(process.cwd());
    const response = await fetch(`${baseUrl}/ws/control`);
    expect(response.status).toBe(404);
  });

  test("fallback route returns 404 for WebSocket terminal path", async () => {
    await startServer(process.cwd());
    const response = await fetch(`${baseUrl}/ws/terminal`);
    expect(response.status).toBe(404);
  });

  test("fallback route returns 404 for any /ws/* path", async () => {
    await startServer(process.cwd());
    const response = await fetch(`${baseUrl}/ws/unknown`);
    expect(response.status).toBe(404);

    const response2 = await fetch(`${baseUrl}/ws/`);
    expect(response2.status).toBe(404);

    const response3 = await fetch(`${baseUrl}/ws/anything/nested`);
    expect(response3.status).toBe(404);
  });

  test("API routes are not affected by fallback", async () => {
    await startServer(process.cwd());
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("non-WebSocket SPA routes attempt to serve index.html", async () => {
    await startServer(process.cwd());
    // These will return 500 if index.html doesn't exist, which is expected
    // The important thing is they don't return 404 like WebSocket paths
    const response = await fetch(`${baseUrl}/session/main`);
    expect(response.status).not.toBe(404);
  });

  test("root path attempts to serve index.html", async () => {
    await startServer(process.cwd());
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).not.toBe(404);
  });

  test("fallback route handles missing frontend gracefully", async () => {
    await startServer("/nonexistent/path");

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).toContain("Frontend not built");
  });
});