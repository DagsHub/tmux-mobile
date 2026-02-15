import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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

  const createFrontendFixture = async (): Promise<string> => {
    const frontendDir = await mkdtemp(path.join(tmpdir(), "tmux-mobile-frontend-"));
    await writeFile(
      path.join(frontendDir, "index.html"),
      "<!doctype html><html><body><div id=\"app\">fixture-index</div></body></html>"
    );
    return frontendDir;
  };

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

  test("non-WebSocket SPA routes serve index.html", async () => {
    const frontendDir = await createFrontendFixture();
    try {
      await startServer(frontendDir);
      const response = await fetch(`${baseUrl}/session/main`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("fixture-index");
    } finally {
      await rm(frontendDir, { recursive: true, force: true });
    }
  });

  test("root path serves index.html", async () => {
    const frontendDir = await createFrontendFixture();
    try {
      await startServer(frontendDir);
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("fixture-index");
    } finally {
      await rm(frontendDir, { recursive: true, force: true });
    }
  });

  test("fallback route handles missing frontend gracefully", async () => {
    await startServer("/nonexistent/path");

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).toContain("Frontend not built");
  });
});
