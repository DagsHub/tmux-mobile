export interface RuntimeConfig {
  port: number;
  host: string;
  password?: string;
  tunnel: boolean;
  defaultSession: string;
  scrollbackLines: number;
  pollIntervalMs: number;
  token: string;
  frontendDir: string;
}

export interface CliArgs {
  port: number;
  password?: string;
  tunnel: boolean;
  session: string;
  scrollback: number;
  debugLog?: string;
}
