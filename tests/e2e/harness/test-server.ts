import path from "node:path";
import type { AddressInfo } from "node:net";
import { AuthService } from "../../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../../src/backend/config.js";
import { createTmuxMobileServer, type RunningServer } from "../../../src/backend/server.js";
import { FakePtyFactory } from "../../harness/fakePty.js";
import { FakeTmuxGateway } from "../../harness/fakeTmux.js";

export interface E2EServerOptions {
  sessions: string[];
  attachedSession?: string;
  failSwitchClient?: boolean;
  defaultSession?: string;
}

export interface StartedE2EServer {
  baseUrl: string;
  token: string;
  ptyFactory: FakePtyFactory;
  tmux: FakeTmuxGateway;
  stop: () => Promise<void>;
}

export const startE2EServer = async (
  options: E2EServerOptions
): Promise<StartedE2EServer> => {
  const token = "e2e-token";
  const authService = new AuthService(undefined, token);
  const tmux = new FakeTmuxGateway(options.sessions, {
    attachedSession: options.attachedSession,
    failSwitchClient: options.failSwitchClient
  });
  const ptyFactory = new FakePtyFactory();

  const config: RuntimeConfig = {
    port: 0,
    host: "127.0.0.1",
    password: undefined,
    tunnel: false,
    defaultSession: options.defaultSession ?? "main",
    scrollbackLines: 1000,
    pollIntervalMs: 100,
    token,
    frontendDir: path.resolve(process.cwd(), "dist/frontend")
  };

  const server: RunningServer = createTmuxMobileServer(config, {
    tmux,
    ptyFactory,
    authService,
    logger: {
      log: () => undefined,
      error: () => undefined
    }
  });

  await server.start();
  const address = server.server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    ptyFactory,
    tmux,
    stop: () => server.stop()
  };
};
