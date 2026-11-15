import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const CHUNK = 'a'.repeat(64 * 1024);

/** A server that answers 200 and never stops sending. */
export interface EndlessServer {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /**
   * Stops the server and its connections.
   * @returns Resolves when it is closed.
   */
  close(): Promise<void>;
}

/**
 * Starts a server whose body never ends, so only a size limit lets a client finish before its deadline.
 * @returns Its address and a way to stop it.
 */
export async function startEndlessServer(): Promise<EndlessServer> {
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/plain');

    const pump = (): void => {
      while (!response.destroyed) {
        if (!response.write(CHUNK)) {
          response.once('drain', pump);

          return;
        }
      }
    };

    pump();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: async () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    }),
  };
}
