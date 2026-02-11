import { WebSocket, type RawData } from "ws";

export const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

export const waitForMessage = <T = unknown>(
  socket: WebSocket,
  matcher?: (payload: T) => boolean,
  timeoutMs = 3_000
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for ws message"));
    }, timeoutMs);

    const handler = (raw: RawData) => {
      const text = raw.toString("utf8");
      const payload = JSON.parse(text) as T;
      if (matcher && !matcher(payload)) {
        return;
      }

      clearTimeout(timeout);
      socket.off("message", handler);
      resolve(payload);
    };

    socket.on("message", handler);
  });

export const openSocket = async (url: string): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await waitForOpen(socket);
  return socket;
};
