import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import { createTmuxMobileServer, type RunningServer } from "../../src/backend/server.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeTmuxGateway } from "../harness/fakeTmux.js";

const buildConfig = (token: string, password?: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 2000,
  pollIntervalMs: 250,
  token,
  frontendDir: process.cwd()
});

describe("API endpoints", () => {
  let runningServer: RunningServer | undefined;
  let baseUrl: string;

  const startServer = async (password?: string): Promise<void> => {
    const tmux = new FakeTmuxGateway([]);
    const ptyFactory = new FakePtyFactory();
    const auth = new AuthService(password, "api-test-token");

    runningServer = createTmuxMobileServer(buildConfig("api-test-token", password), {
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

  test("GET /api/config returns config without password", async () => {
    await startServer();
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.ok).toBe(true);

    const config = await response.json();
    expect(config).toEqual({
      passwordRequired: false,
      scrollbackLines: 2000,
      pollIntervalMs: 250
    });
  });

  test("GET /api/config indicates when password is required", async () => {
    await startServer("secret123");

    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.ok).toBe(true);

    const config = await response.json();
    expect(config).toEqual({
      passwordRequired: true,
      scrollbackLines: 2000,
      pollIntervalMs: 250
    });
  });

  test("GET /api/config returns correct scrollbackLines from config", async () => {
    const tmux = new FakeTmuxGateway([]);
    const ptyFactory = new FakePtyFactory();
    const customConfig: RuntimeConfig = {
      port: 0,
      host: "127.0.0.1",
      password: undefined,
      tunnel: false,
      defaultSession: "main",
      scrollbackLines: 5000,
      pollIntervalMs: 500,
      token: "test",
      frontendDir: process.cwd()
    };

    runningServer = createTmuxMobileServer(customConfig, {
      tmux,
      ptyFactory,
      logger: { log: () => undefined, error: () => undefined }
    });

    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${url}/api/config`);
    const config = await response.json();

    expect(config.scrollbackLines).toBe(5000);
    expect(config.pollIntervalMs).toBe(500);
  });
});