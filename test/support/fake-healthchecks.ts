import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const PATH_BYTES = 12;

/** Running fake of a heartbeat service such as healthchecks.io. */
export interface FakeHealthchecks {
  /** `http://127.0.0.1:<port>/ping/<random>`; the path is the secret of the check. */
  readonly url: string;
  /** Random part of the path. */
  readonly key: string;
  /** Pings that reached the path of the check. */
  readonly pings: number;
  /**
   * Changes the status of later answers.
   * @param status HTTP status.
   */
  setStatus(status: number): void;
  /**
   * Stops the server and drops its connections.
   * @returns Resolves when the port is released.
   */
  close(): Promise<void>;
}

/**
 * Starts a fake heartbeat service on a random loopback port.
 * @returns Running fake that answers 200 to `GET` on its path and 404 elsewhere.
 */
export async function startFakeHealthchecks(): Promise<FakeHealthchecks> {
  const key = randomBytes(PATH_BYTES).toString('hex');
  const path = `/ping/${key}`;
  let status = 200;
  let pings = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === path) {
      pings += 1;
      res.statusCode = status;
    } else {
      res.statusCode = 404;
    }

    res.end('OK');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}${path}`,
    key,
    get pings() {
      return pings;
    },
    setStatus: (next) => {
      status = next;
    },
    close: async () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}
