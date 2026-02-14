import { EventEmitter } from "node:events";
import { SignJWT, jwtVerify } from "jose";
import type { ApprovalServiceOptions, PendingConnection } from "./approval-types.js";
import { randomToken } from "../util/random.js";

export class ApprovalService extends EventEmitter {
  private readonly pending = new Map<string, PendingConnection>();
  private readonly jwtSecret: Uint8Array;
  private readonly jwtLifetimeSecs: number;

  public constructor(options: ApprovalServiceOptions) {
    super();
    this.jwtSecret = options.jwtSecret;
    this.jwtLifetimeSecs = options.jwtLifetimeSecs;
  }

  public addPending(params: Omit<PendingConnection, "id" | "challengeCode" | "timestamp">): PendingConnection {
    const id = randomToken(12);
    const challengeCode = randomToken(3).slice(0, 4).toUpperCase();
    const connection: PendingConnection = {
      ...params,
      id,
      challengeCode,
      timestamp: Date.now()
    };
    this.pending.set(id, connection);
    this.emit("pending-added", connection);
    return connection;
  }

  public getPending(): PendingConnection[] {
    return Array.from(this.pending.values());
  }

  public async approve(id: string): Promise<{ connectionId: string; jwt: string } | null> {
    const connection = this.pending.get(id);
    if (!connection) {
      return null;
    }

    const jwt = await new SignJWT({ clientId: connection.clientId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${this.jwtLifetimeSecs}s`)
      .sign(this.jwtSecret);

    this.pending.delete(id);
    const result = { connectionId: id, jwt };
    this.emit("approved", { ...result, clientId: connection.clientId });
    return result;
  }

  public deny(id: string): boolean {
    const connection = this.pending.get(id);
    if (!connection) {
      return false;
    }
    this.pending.delete(id);
    this.emit("denied", { connectionId: id });
    return true;
  }

  public async verifyJwt(token: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      await jwtVerify(token, this.jwtSecret);
      return { valid: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid token";
      return { valid: false, reason };
    }
  }

  public async signJwt(clientId: string): Promise<string> {
    return new SignJWT({ clientId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${this.jwtLifetimeSecs}s`)
      .sign(this.jwtSecret);
  }

  public removePending(id: string): boolean {
    const existed = this.pending.delete(id);
    if (existed) {
      this.emit("pending-removed", { connectionId: id });
    }
    return existed;
  }
}
