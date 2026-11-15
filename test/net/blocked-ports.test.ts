import { describe, expect, it } from 'vitest';
import { BLOCKED_PORTS, blockedPortOf } from '../../src/net/blocked-ports.js';

describe('BLOCKED_PORTS', () => {
  it('lists exactly the ports the running fetch refuses', async () => {
    const refused: number[] = [];

    // Blocked ports fail before any connection, so the loop needs no server and no waiting for a refused connection.
    for (const port of BLOCKED_PORTS) {
      const error = await fetch(`http://127.0.0.1:${String(port)}/`).catch((caught: unknown) => caught);

      if (error instanceof TypeError && (error.cause as Error | undefined)?.message === 'bad port') {
        refused.push(port);
      }
    }

    expect(refused).toEqual([...BLOCKED_PORTS]);
  });
});

describe('blockedPortOf', () => {
  it('reads an explicit port', () => {
    expect(blockedPortOf('http://localhost:6000/x')).toBe(6000);
    expect(blockedPortOf('https://example.test:8443/')).toBeUndefined();
  });

  it('ignores default ports and text that is not a URL', () => {
    expect(blockedPortOf('http://localhost/')).toBeUndefined();
    expect(blockedPortOf('not a url')).toBeUndefined();
  });
});
