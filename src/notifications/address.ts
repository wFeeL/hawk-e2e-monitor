import { CheckError } from '../errors/taxonomy.js';
import { NetworkError, requestWithRetry } from '../net/http.js';
import type { HttpResponse } from '../net/http.js';
import type { Clock } from '../time/clock.js';
import { HttpStatus } from '../net/http-status.js';

const FULL_ATTEMPTS = 3;
const FIRST_RETRY_DELAY_MS = 200;
const SECOND_RETRY_DELAY_MS = 500;
const DEFAULT_RETRY_DELAYS_MS = [FIRST_RETRY_DELAY_MS, SECOND_RETRY_DELAY_MS] as const;
const PROBE_PATH = '/hooks/probe/';

/** Where Hawk can reach the receiver. */
export interface PublicAddress {
  /** Address without a trailing slash. */
  baseUrl: string;
  /** Host of the address, with the port when it has one; masked in output. */
  hostname: string;
  /** Where the address came from. */
  source: 'config' | 'tunnel';
}

/** Where the public address may come from. */
export interface AddressSettings {
  /** Fixed public https address. */
  publicBaseUrl?: string;
  /** Metrics address of the tunnel. */
  tunnelMetricsUrl?: string;
}

/** Time limits and clock of the address calls. */
export interface AddressDeps {
  /** Deadline of one request. */
  httpTimeoutMs: number;
  /** Clock for the pauses between attempts. */
  clock: Clock;
  /** Pauses between attempts, `[200, 500]` by default. */
  retryDelaysMs?: readonly number[];
}

/** Time limits of the probe, with the number of attempts. */
export interface ProbeDeps extends AddressDeps {
  /** One for a recheck, three for the first probe. */
  attempts: typeof FULL_ATTEMPTS | 1;
}

/** The part of the tunnel answer that is read. */
interface TunnelAnswerBody {
  /** Public hostname of the quick tunnel. */
  hostname?: unknown;
}

/**
 * Cuts trailing slashes off an address.
 * @param value Address.
 * @returns Address without trailing slashes.
 */
function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

/**
 * Sends a GET that repeats on 5xx and on network failures.
 * @param url Address.
 * @param deps Time limit, clock and pauses.
 * @param attempts Total attempts.
 * @param signal Aborts the request and the pauses.
 * @returns Last answer.
 * @throws NetworkError when the last attempt failed on the network.
 */
async function get(url: string, deps: AddressDeps, attempts: number, signal: AbortSignal): Promise<HttpResponse> {
  const { response } = await requestWithRetry({ url,
    method: 'GET',
    timeoutMs: deps.httpTimeoutMs,
    signal }, 'api', { attempts,
    delaysMs: deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
    clock: deps.clock,
    retryStatus: status => status >= HttpStatus.internalServerError,
    retryNetwork: () => true });

  return response;
}

/**
 * Reads the hostname from the answer of the tunnel.
 * @param text Body of the answer.
 * @returns Hostname, or undefined when the body has none.
 */
function tunnelHostname(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as TunnelAnswerBody | null;

    return typeof parsed?.hostname === 'string' && parsed.hostname.trim() !== '' ? parsed.hostname.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds the address Hawk uses to reach the receiver.
 * @param settings Fixed address or tunnel metrics address.
 * @param deps Time limit, clock and pauses.
 * @param signal Aborts the requests.
 * @returns Public address; the fixed one wins over the tunnel.
 * @throws CheckError `tunnel_unavailable` when the tunnel gives no hostname, `monitor_internal` when no source is set.
 */
export async function resolvePublicAddress(settings: AddressSettings, deps: AddressDeps, signal: AbortSignal): Promise<PublicAddress> {
  if (settings.publicBaseUrl !== undefined) {
    const baseUrl = withoutTrailingSlash(settings.publicBaseUrl);

    return { baseUrl,
      hostname: new URL(baseUrl).host,
      source: 'config' };
  }

  if (settings.tunnelMetricsUrl === undefined) {
    throw new CheckError('monitor_internal', { detail: 'neither PUBLIC_BASE_URL nor TUNNEL_METRICS_URL is set' });
  }

  const url = `${withoutTrailingSlash(settings.tunnelMetricsUrl)}/quicktunnel`;
  let response: HttpResponse;

  try {
    response = await get(url, deps, FULL_ATTEMPTS, signal);
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new CheckError('tunnel_unavailable', { url,
        detail: `request failed: ${error.failure.code}` }, { cause: error });
    }

    throw error;
  }

  if (response.status !== HttpStatus.ok) {
    throw new CheckError('tunnel_unavailable', { url,
      detail: `answered HTTP ${String(response.status)}` });
  }

  const hostname = tunnelHostname(response.text);

  if (hostname === undefined) {
    throw new CheckError('tunnel_unavailable', { url,
      detail: 'the answer has no hostname' });
  }

  return { baseUrl: `https://${hostname}`,
    hostname,
    source: 'tunnel' };
}

/**
 * Checks through the public address that the request reaches this receiver.
 * @param address Public address.
 * @param secret Secret of the receiver paths; never written to an error.
 * @param expectedNonce Nonce the receiver returns.
 * @param deps Time limit, clock, pauses and attempts.
 * @param signal Aborts the requests.
 * @returns Resolves when the receiver answered with the nonce.
 * @throws CheckError `receiver_unreachable` otherwise.
 */
export async function probeReceiver(address: PublicAddress, secret: string, expectedNonce: string, deps: ProbeDeps, signal: AbortSignal): Promise<void> {
  const shown = `${address.baseUrl}${PROBE_PATH}…`;
  let response: HttpResponse;

  try {
    response = await get(`${address.baseUrl}${PROBE_PATH}${secret}`, deps, deps.attempts, signal);
  } catch (error) {
    if (error instanceof NetworkError) {
      // The cause is left out because it may carry the URL with the secret.
      throw new CheckError('receiver_unreachable', { detail: `${shown} failed: ${error.failure.code}` });
    }

    throw error;
  }

  if (response.status !== HttpStatus.ok) {
    throw new CheckError('receiver_unreachable', { detail: `${shown} answered HTTP ${String(response.status)}` });
  }

  if (response.text !== expectedNonce) {
    throw new CheckError('receiver_unreachable', { detail: `${shown} answered with another nonce, so the address leads to a different service` });
  }
}
