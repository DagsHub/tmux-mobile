import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const URL_REGEX = /https:\/\/[a-z0-9.-]+\.trycloudflare\.com/i;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

type ExecFileImpl = (file: string, args: string[]) => Promise<unknown>;

type SpawnedProcess = {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): SpawnedProcess;
  on(event: "exit", listener: (code: number | null) => void): SpawnedProcess;
};

type SpawnProcess = (
  command: string,
  args: string[],
  options: {
    stdio: ["ignore", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
  }
) => SpawnedProcess;

export interface CloudflaredManagerOptions {
  execFileImpl?: ExecFileImpl;
  spawnProcess?: SpawnProcess;
  startupTimeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface CloudflaredResult {
  publicUrl: string;
}

const architectureToRelease = (arch: NodeJS.Architecture): string => {
  switch (arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Unsupported Linux architecture for cloudflared auto-install: ${arch}`);
  }
};

const summarizeOutput = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 400) {
    return normalized;
  }

  return `${normalized.slice(0, 397)}...`;
};

export class CloudflaredManager {
  private process?: SpawnedProcess;
  private executable = "cloudflared";
  private readonly execFileImpl: ExecFileImpl;
  private readonly spawnProcess: SpawnProcess;
  private readonly startupTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  public constructor(options: CloudflaredManagerOptions = {}) {
    this.execFileImpl = options.execFileImpl ?? ((file, args) => execFileAsync(file, args));
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) =>
        spawn(command, args, spawnOptions) as unknown as SpawnedProcess);
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  public async ensureInstalled(): Promise<void> {
    const userBinary = path.join(os.homedir(), ".local", "bin", "cloudflared");

    if (await this.isExecutableAvailable("cloudflared")) {
      this.executable = "cloudflared";
      return;
    }

    if (await this.isExecutableAvailable(userBinary)) {
      this.executable = userBinary;
      return;
    }

    await this.tryInstall();

    if (await this.isExecutableAvailable("cloudflared")) {
      this.executable = "cloudflared";
      return;
    }

    if (await this.isExecutableAvailable(userBinary)) {
      this.executable = userBinary;
      return;
    }

    throw new Error("cloudflared installation completed but executable was not found");
  }

  public async start(port: number): Promise<CloudflaredResult> {
    await this.ensureInstalled();
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.startOnce(port);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.stop();
        if (attempt < this.maxAttempts) {
          await this.delay(this.retryDelayMs);
        }
      }
    }

    throw new Error(
      `cloudflared failed after ${this.maxAttempts} attempts: ${lastError?.message ?? "unknown error"}`
    );
  }

  public stop(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      this.process = undefined;
    }
  }

  private async startOnce(port: number): Promise<CloudflaredResult> {
    const child = this.spawnProcess(this.executable, ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    this.process = child;

    return new Promise<CloudflaredResult>((resolve, reject) => {
      const stderrChunks: string[] = [];
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (handler: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        handler();
      };

      const readText = (chunk: Buffer | string): string =>
        typeof chunk === "string" ? chunk : chunk.toString("utf8");

      const buildError = (message: string): Error => {
        const stderrText = summarizeOutput(stderrChunks.join(""));
        return stderrText ? new Error(`${message}: ${stderrText}`) : new Error(message);
      };

      const onData = (chunk: Buffer | string): void => {
        const text = readText(chunk);
        const match = text.match(URL_REGEX);
        if (!match) {
          return;
        }

        finish(() => resolve({ publicUrl: match[0] }));
      };

      const onStderr = (chunk: Buffer | string): void => {
        stderrChunks.push(readText(chunk));
        onData(chunk);
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onStderr);
      child.on("error", (error) => {
        if (this.process === child) {
          this.process = undefined;
        }
        finish(() => reject(buildError(`cloudflared failed to start: ${error.message}`)));
      });
      child.on("exit", (code) => {
        if (this.process === child) {
          this.process = undefined;
        }
        if (settled) {
          return;
        }

        const exitCode = code ?? -1;
        const message =
          code === 0
            ? "cloudflared exited before URL was emitted"
            : `cloudflared exited before URL was emitted (${exitCode})`;
        finish(() => reject(buildError(message)));
      });

      timeout = setTimeout(() => {
        if (this.process === child) {
          this.process = undefined;
        }
        finish(() => reject(buildError("Timed out waiting for cloudflared URL")));
      }, this.startupTimeoutMs);
    });
  }

  private async isExecutableAvailable(binary: string): Promise<boolean> {
    try {
      await this.execFileImpl(binary, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  private async tryInstall(): Promise<void> {
    switch (process.platform) {
      case "darwin": {
        await this.execFileImpl("brew", ["install", "cloudflared"]);
        return;
      }
      case "linux": {
        const installDir = path.join(os.homedir(), ".local", "bin");
        const releaseArch = architectureToRelease(process.arch);
        const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${releaseArch}`;
        await this.execFileImpl("bash", [
          "-lc",
          `mkdir -p "${installDir}" && curl -fsSL "${downloadUrl}" -o "${installDir}/cloudflared" && chmod +x "${installDir}/cloudflared"`
        ]);
        return;
      }
      default:
        throw new Error(`cloudflared auto-install unsupported on ${process.platform}`);
    }
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
