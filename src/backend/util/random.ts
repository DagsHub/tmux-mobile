import crypto from "node:crypto";

export const randomToken = (size = 18): string =>
  crypto.randomBytes(size).toString("base64url");
