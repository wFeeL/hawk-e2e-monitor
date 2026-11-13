/** The collector answered. */
export interface WsResponse {
  /** Discriminator. */
  kind: 'response';
  /** Text of the first message; empty for a non-text frame. */
  text: string;
}

/** The socket never opened. */
export interface WsHandshakeFailed {
  /** Discriminator. */
  kind: 'handshake_failed';
  /** What is known: the browser API hides the reason and the HTTP status. */
  detail: string;
}

/** The socket closed after it opened and before an answer came. */
export interface WsClosed {
  /** Discriminator. */
  kind: 'closed';
  /** True when the message was sent. */
  sent: boolean;
  /** Close code; 1005 means the peer gave none. */
  code: number;
}

/** No answer within the deadline, or the signal aborted. */
export interface WsTimeout {
  /** Discriminator. */
  kind: 'timeout';
  /** True when the message was sent. */
  sent: boolean;
}

/** Result of one exchange. */
export type WsOutcome = WsResponse | WsHandshakeFailed | WsClosed | WsTimeout;

/** Limits of one exchange. */
export interface WsSendOptions {
  /** Deadline from the creation of the socket. */
  timeoutMs: number;
  /** Aborts the exchange. */
  signal: AbortSignal;
}

const ABNORMAL_CLOSE = 1006;

/**
 * Opens a socket, sends one message and waits for the first answer.
 * The socket is closed and every listener removed whatever the outcome.
 * @param url `ws://` or `wss://` address.
 * @param message Text to send once the socket is open.
 * @param options Deadline and abort signal.
 * @returns How the exchange ended.
 * @throws SyntaxError when the URL is invalid.
 */
export async function sendOverWebSocket(url: string, message: string, options: WsSendOptions): Promise<WsOutcome> {
  if (options.signal.aborted) {
    return { kind: 'timeout',
      sent: false };
  }

  const socket = new WebSocket(url);
  let opened = false;
  let sent = false;
  let cleanup = (): void => undefined;

  try {
    return await new Promise<WsOutcome>((resolve) => {
      const onOpen = (): void => {
        opened = true;

        try {
          socket.send(message);
          sent = true;
        } catch {
          resolve({ kind: 'closed',
            sent: false,
            code: ABNORMAL_CLOSE });
        }
      };
      const onMessage = (event: MessageEvent): void => {
        resolve({ kind: 'response',
          text: typeof event.data === 'string' ? event.data : '' });
      };
      // An `error` is always followed by `close`, which carries the code; so only `close` settles.
      const onClose = (event: CloseEvent): void => {
        resolve(opened
          ? { kind: 'closed',
              sent,
              code: event.code }
          : { kind: 'handshake_failed',
              detail: `connection closed before open (code ${String(event.code)})` });
      };
      const onTimeout = (): void => {
        resolve({ kind: 'timeout',
          sent });
      };
      const timer = setTimeout(onTimeout, options.timeoutMs);

      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      options.signal.addEventListener('abort', onTimeout, { once: true });
      cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
        options.signal.removeEventListener('abort', onTimeout);
      };
    });
  } finally {
    cleanup();

    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
}
