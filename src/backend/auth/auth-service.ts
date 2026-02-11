import { randomToken } from "../util/random.js";

export interface AuthPayload {
  token?: string;
  password?: string;
}

export class AuthService {
  public readonly token: string;
  private readonly password?: string;

  public constructor(password?: string, token?: string) {
    this.password = password;
    this.token = token ?? randomToken();
  }

  public requiresPassword(): boolean {
    return Boolean(this.password);
  }

  public verify(payload: AuthPayload): { ok: boolean; reason?: string } {
    if (!payload.token || payload.token !== this.token) {
      return { ok: false, reason: "invalid token" };
    }

    if (this.password && payload.password !== this.password) {
      return { ok: false, reason: "invalid password" };
    }

    return { ok: true };
  }
}
