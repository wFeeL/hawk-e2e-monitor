import type { PublicAddress } from '../../src/notifications/address.js';

/**
 * Builds a public address that points at a receiver on the loopback interface over plain HTTP.
 * The real resolver only yields https, which a test receiver does not speak.
 * @param port Port of the receiver.
 * @param source Where the address pretends to come from.
 * @returns Address with the host and the port as the hostname.
 */
export function httpAddress(port: number, source: PublicAddress['source'] = 'config'): PublicAddress {
  return { baseUrl: `http://127.0.0.1:${String(port)}`,
    hostname: `127.0.0.1:${String(port)}`,
    source };
}
