/** A viewer transport. ws.WebSocket and the Local Agent's multiplexed peer both implement it. */
export interface Peer {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
