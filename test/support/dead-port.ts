import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A loopback port whose server drops every connection. */
export interface DeadPort {
  /** The server; the caller closes it. */
  server: Server;
  /** Port it listens on. */
  port: number;
}

/**
 * Starts a server that resets every connection, so a request to it fails for sure.
 * A closed port could be taken by another process before the test uses it; this one stays ours.
 * @returns The server and its port.
 */
export async function startDeadPort(): Promise<DeadPort> {
  const server = createServer();

  server.on('connection', (socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return { server,
    port: (server.address() as AddressInfo).port };
}
