#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { AuthService } from "./auth/auth-service.js";
import { CloudflaredManager } from "./cloudflared/manager.js";
import type { CliArgs, RuntimeConfig } from "./config.js";
import { NodePtyFactory } from "./pty/node-pty-adapter.js";
import { createTmuxMobileServer } from "./server.js";
import { TmuxCliExecutor } from "./tmux/cli-executor.js";
import { createLogger } from "./util/file-logger.js";
import { randomToken } from "./util/random.js";

const parseCliArgs = async (): Promise<CliArgs> => {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("tmux-mobile")
    .option("port", {
      alias: "p",
      type: "number",
      default: 8767,
      describe: "Local port"
    })
    .option("password", {
      type: "string",
      describe: "Password for authentication (auto-generated when protection is enabled)"
    })
    .option("require-password", {
      type: "boolean",
      default: true,
      describe: "Require password authentication"
    })
    .option("tunnel", {
      type: "boolean",
      default: true,
      describe: "Start cloudflared quick tunnel"
    })
    .option("session", {
      type: "string",
      default: "main",
      describe: "Default tmux session name"
    })
    .option("scrollback", {
      type: "number",
      default: 1000,
      describe: "Default scrollback capture lines"
    })
    .option("debug-log", {
      type: "string",
      describe: "Write debug logs to a file"
    })
    .strict()
    .help()
    .parseAsync();

  return {
    port: argv.port,
    password: argv.password,
    requirePassword: argv.requirePassword,
    tunnel: argv.tunnel,
    session: argv.session,
    scrollback: argv.scrollback,
    debugLog: argv.debugLog
  };
};

const buildLaunchUrl = (baseUrl: string, token: string): string => {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
};

const printConnectionInfo = (
  localUrl: string,
  tunnelUrl: string | undefined,
  token: string,
  password?: string
): void => {
  const localWithToken = buildLaunchUrl(localUrl, token);
  console.log(`Local URL: ${localWithToken}`);
  if (password) {
    console.log(`Password: ${password}`);
  }

  if (tunnelUrl) {
    const tunnelWithToken = buildLaunchUrl(tunnelUrl, token);
    console.log(`Tunnel URL: ${tunnelWithToken}`);
    qrcode.generate(tunnelWithToken, { small: true });
    return;
  }

  qrcode.generate(localWithToken, { small: true });
};

const main = async (): Promise<void> => {
  const args = await parseCliArgs();
  const effectivePassword = args.requirePassword ? args.password ?? randomToken(16) : undefined;
  const authService = new AuthService(effectivePassword);
  const debugLogPath = args.debugLog ?? process.env.TMUX_MOBILE_DEBUG_LOG;
  const logger = createLogger(debugLogPath);
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDir = path.resolve(cliDir, "../frontend");

  const config: RuntimeConfig = {
    port: args.port,
    host: "127.0.0.1",
    password: effectivePassword,
    tunnel: args.tunnel,
    defaultSession: args.session,
    scrollbackLines: args.scrollback,
    pollIntervalMs: 2_500,
    token: authService.token,
    frontendDir
  };

  const cloudflaredManager = new CloudflaredManager();
  const tmux = new TmuxCliExecutor({
    socketName: process.env.TMUX_MOBILE_SOCKET_NAME,
    socketPath: process.env.TMUX_MOBILE_SOCKET_PATH,
    logger
  });
  const ptyFactory = new NodePtyFactory(logger);
  const runningServer = createTmuxMobileServer(config, {
    tmux,
    ptyFactory,
    authService,
    logger
  });

  if (debugLogPath) {
    logger.log(`Debug log file: ${path.resolve(debugLogPath)}`);
  }

  await runningServer.start();

  let tunnelUrl: string | undefined;
  if (args.tunnel) {
    try {
      const tunnel = await cloudflaredManager.start(args.port);
      tunnelUrl = tunnel.publicUrl;
    } catch (error) {
      console.error(`Unable to start cloudflared: ${String(error)}`);
    }
  }

  printConnectionInfo(`http://localhost:${args.port}`, tunnelUrl, authService.token, effectivePassword);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }

    shutdownPromise = (async () => {
      cloudflaredManager.stop();
      await runningServer.stop();
    })();

    try {
      await shutdownPromise;
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
};

void main();
