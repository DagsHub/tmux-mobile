import crypto from "node:crypto";
import { describe, expect, test, beforeEach } from "vitest";
import { ApprovalService } from "../../src/backend/auth/approval-service.js";
import type { PendingConnection } from "../../src/backend/auth/approval-types.js";
import { WebSocket } from "ws";

const makeService = (lifetimeSecs = 3600): ApprovalService =>
  new ApprovalService({
    jwtSecret: crypto.randomBytes(32),
    jwtLifetimeSecs: lifetimeSecs
  });

const fakePendingParams = () => ({
  clientId: "client-1",
  socket: {} as WebSocket,
  ip: "192.168.1.1",
  userAgent: "Mozilla/5.0",
  geoLocation: "Unknown"
});

describe("ApprovalService", () => {
  let service: ApprovalService;

  beforeEach(() => {
    service = makeService();
  });

  test("addPending creates a pending connection with challenge code", () => {
    const pending = service.addPending(fakePendingParams());

    expect(pending.id).toBeTruthy();
    expect(pending.challengeCode).toHaveLength(4);
    expect(pending.challengeCode).toMatch(/^[A-Z0-9_-]+$/i);
    expect(pending.clientId).toBe("client-1");
    expect(pending.ip).toBe("192.168.1.1");
    expect(pending.timestamp).toBeGreaterThan(0);
  });

  test("getPending returns all pending connections", () => {
    service.addPending(fakePendingParams());
    service.addPending({ ...fakePendingParams(), clientId: "client-2" });

    const pending = service.getPending();
    expect(pending).toHaveLength(2);
  });

  test("addPending emits pending-added event", () => {
    const emitted: PendingConnection[] = [];
    service.on("pending-added", (conn: PendingConnection) => emitted.push(conn));

    service.addPending(fakePendingParams());

    expect(emitted).toHaveLength(1);
    expect(emitted[0].clientId).toBe("client-1");
  });

  test("approve returns JWT and removes from pending", async () => {
    const pending = service.addPending(fakePendingParams());

    const result = await service.approve(pending.id);
    expect(result).not.toBeNull();
    expect(result!.jwt).toBeTruthy();
    expect(result!.connectionId).toBe(pending.id);

    expect(service.getPending()).toHaveLength(0);
  });

  test("approve emits approved event with jwt and clientId", async () => {
    const pending = service.addPending(fakePendingParams());
    const events: Array<{ connectionId: string; jwt: string; clientId: string }> = [];
    service.on("approved", (e) => events.push(e));

    await service.approve(pending.id);

    expect(events).toHaveLength(1);
    expect(events[0].clientId).toBe("client-1");
    expect(events[0].jwt).toBeTruthy();
  });

  test("approve returns null for unknown id", async () => {
    const result = await service.approve("nonexistent");
    expect(result).toBeNull();
  });

  test("deny removes from pending and emits denied event", () => {
    const pending = service.addPending(fakePendingParams());
    const events: Array<{ connectionId: string }> = [];
    service.on("denied", (e) => events.push(e));

    const result = service.deny(pending.id);
    expect(result).toBe(true);
    expect(service.getPending()).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].connectionId).toBe(pending.id);
  });

  test("deny returns false for unknown id", () => {
    expect(service.deny("nonexistent")).toBe(false);
  });

  test("removePending cleans up and emits pending-removed", () => {
    const pending = service.addPending(fakePendingParams());
    const events: Array<{ connectionId: string }> = [];
    service.on("pending-removed", (e) => events.push(e));

    const result = service.removePending(pending.id);
    expect(result).toBe(true);
    expect(service.getPending()).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  test("removePending returns false for unknown id", () => {
    expect(service.removePending("nonexistent")).toBe(false);
  });

  test("signJwt produces a verifiable token", async () => {
    const jwt = await service.signJwt("client-42");
    const result = await service.verifyJwt(jwt);
    expect(result.valid).toBe(true);
  });

  test("verifyJwt rejects invalid tokens", async () => {
    const result = await service.verifyJwt("garbage.token.here");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test("verifyJwt rejects tokens signed with a different secret", async () => {
    const otherService = makeService();
    const jwt = await otherService.signJwt("client-1");

    const result = await service.verifyJwt(jwt);
    expect(result.valid).toBe(false);
  });

  test("approve-issued JWT is verifiable", async () => {
    const pending = service.addPending(fakePendingParams());
    const result = await service.approve(pending.id);

    const verification = await service.verifyJwt(result!.jwt);
    expect(verification.valid).toBe(true);
  });
});
