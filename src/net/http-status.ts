/** HTTP status codes the service sends or inspects. */
export const HttpStatus = {
  ok: 200,
  accepted: 202,
  partialContent: 206,
  badRequest: 400,
  unauthorized: 401,
  paymentRequired: 402,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  payloadTooLarge: 413,
  tooManyRequests: 429,
  internalServerError: 500,
  serviceUnavailable: 503,
} as const;
