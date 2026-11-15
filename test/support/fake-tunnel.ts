import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the fake tunnel answers. */
export interface TunnelAnswer {
  /** HTTP status. */
  status: number;
  /** Body text. */
  body: string;
}

/** A running fake of the metrics endpoint of a tunnel. */
export interface FakeTunnelMetrics {
  /** Base URL, without a trailing slash. */
  url: string;
  /** Requests received so far. */
  hits(): number;
  /**
   * Stops the server and drops open connections.
   * @returns Resolves when the server is closed.
   */
  close(): Promise<void>;
}

/**
 * Starts a fake of the `/quicktunnel` route of cloudflared on a random port.
 * @param answer Called for every request to get the answer.
 * @returns Running fake.
 */
export async function startFakeTunnelMetrics(answer: () => TunnelAnswer): Promise<FakeTunnelMetrics> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    if (req.method !== 'GET' || req.url !== '/quicktunnel') {
      res.writeHead(404);
      res.end();

      return;
    }

    const { status, body } = answer();

    res.writeHead(status);
    res.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    hits: () => hits,
    close: async () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}
