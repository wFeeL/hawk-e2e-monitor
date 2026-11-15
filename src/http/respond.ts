import type { ServerResponse } from 'node:http';

/**
 * Sends a text body that must not be cached.
 * @param res Response to write.
 * @param status Status code of the answer.
 * @param body Content of the answer, already serialized.
 * @param contentType Media type with its parameters.
 * @param headers Extra headers.
 */
export function sendText(res: ServerResponse, status: number, body: string, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-store');

  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }

  res.statusCode = status;
  res.end(body);
}

/**
 * Sends a JSON body that must not be cached.
 * @param res Response to write.
 * @param status HTTP status.
 * @param body Value serialized as the body.
 * @param headers Extra headers.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  sendText(res, status, JSON.stringify(body), 'application/json; charset=utf-8', headers);
}
