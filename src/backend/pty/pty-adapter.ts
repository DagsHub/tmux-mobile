export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (code: number) => void): void;
  kill(): void;
}

export interface PtyFactory {
  spawnTmuxAttach(session: string): PtyProcess;
}
