import { describe, expect, it } from 'vitest';
import { HttpStatus } from '../../src/net/http-status.js';

describe('HttpStatus', () => {
  it('has the codes of the manual run answers', () => {
    expect(HttpStatus.accepted).toBe(202);
    expect(HttpStatus.unauthorized).toBe(401);
    expect(HttpStatus.conflict).toBe(409);
  });
});
