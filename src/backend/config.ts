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
  approvalEnabled: boolean;
  jwtLifetimeSecs: number;
}

export interface CliArgs {
  port: number;
  password?: string;
  requirePassword: boolean;
  tunnel: boolean;
  session: string;
  scrollback: number;
  debugLog?: string;
  noApprove: boolean;
  jwtLifetime: number;
}
