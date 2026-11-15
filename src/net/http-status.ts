/** HTTP status codes the service sends or inspects. */
export const HttpStatus = {
  ok: 200,
  badRequest: 400,
  paymentRequired: 402,
  notFound: 404,
  methodNotAllowed: 405,
  payloadTooLarge: 413,
  tooManyRequests: 429,
  internalServerError: 500,
  serviceUnavailable: 503,
} as const;
