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
    .strict()
    .help()
    .parseAsync();

  return {
    port: argv.port,
    password: argv.password,
    tunnel: argv.tunnel,
    session: argv.session,
    scrollback: argv.scrollback
  };
};

const printConnectionInfo = (
  localUrl: string,
  tunnelUrl: string | undefined,
  token: string
): void => {
  const localWithToken = `${localUrl}/?token=${encodeURIComponent(token)}`;
  console.log(`Local URL: ${localWithToken}`);

  if (tunnelUrl) {
    const tunnelWithToken = `${tunnelUrl}/?token=${encodeURIComponent(token)}`;
    console.log(`Tunnel URL: ${tunnelWithToken}`);
    qrcode.generate(tunnelWithToken, { small: true });
    return;
  }

  qrcode.generate(localWithToken, { small: true });
};

const main = async (): Promise<void> => {
  const args = await parseCliArgs();
  const authService = new AuthService(args.password);
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDir = path.resolve(cliDir, "../frontend");

  const config: RuntimeConfig = {
    port: args.port,
    host: "127.0.0.1",
    password: args.password,
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
    socketPath: process.env.TMUX_MOBILE_SOCKET_PATH
  });
  const ptyFactory = new NodePtyFactory();
  const runningServer = createTmuxMobileServer(config, {
    tmux,
    ptyFactory,
    authService
  });

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

  printConnectionInfo(`http://localhost:${args.port}`, tunnelUrl, authService.token);

  const shutdown = async (): Promise<void> => {
    cloudflaredManager.stop();
    await runningServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
};

void main();
