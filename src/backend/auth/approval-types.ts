import type { WebSocket } from "ws";

export interface PendingConnection {
  id: string;
  clientId: string;
  socket: WebSocket;
  ip: string;
  userAgent: string;
  geoLocation: string;
  challengeCode: string;
  timestamp: number;
}

export interface ApprovalServiceOptions {
  jwtSecret: Uint8Array;
  jwtLifetimeSecs: number;
}
