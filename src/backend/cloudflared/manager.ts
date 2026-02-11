import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const URL_REGEX = /https:\/\/[a-z0-9.-]+\.trycloudflare\.com/i;

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

export class CloudflaredManager {
  private process?: ReturnType<typeof spawn>;
  private executable = "cloudflared";

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
    const args = ["tunnel", "--url", `http://localhost:${port}`];
    this.process = spawn(this.executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    return new Promise<CloudflaredResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for cloudflared URL"));
      }, 30_000);

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        const match = text.match(URL_REGEX);
        if (!match) {
          return;
        }

        clearTimeout(timeout);
        resolve({ publicUrl: match[0] });
      };

      const onError = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        if (text.toLowerCase().includes("error")) {
          clearTimeout(timeout);
          reject(new Error(`cloudflared error: ${text.trim()}`));
        }
      };

      this.process?.stdout?.on("data", onData);
      this.process?.stderr?.on("data", onData);
      this.process?.stderr?.on("data", onError);
      this.process?.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`cloudflared exited before URL was emitted (${code ?? -1})`));
        }
      });
    });
  }

  public stop(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      this.process = undefined;
    }
  }

  private async isExecutableAvailable(binary: string): Promise<boolean> {
    try {
      await execFileAsync(binary, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  private async tryInstall(): Promise<void> {
    switch (process.platform) {
      case "darwin": {
        await execFileAsync("brew", ["install", "cloudflared"]);
        return;
      }
      case "linux": {
        const installDir = path.join(os.homedir(), ".local", "bin");
        const releaseArch = architectureToRelease(process.arch);
        const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${releaseArch}`;
        await execFileAsync("bash", [
          "-lc",
          `mkdir -p "${installDir}" && curl -fsSL "${downloadUrl}" -o "${installDir}/cloudflared" && chmod +x "${installDir}/cloudflared"`
        ]);
        return;
      }
      default:
        throw new Error(`cloudflared auto-install unsupported on ${process.platform}`);
    }
  }
}
