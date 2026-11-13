import { describe, expect, it } from 'vitest';
import { validEnv } from '../test-support/env.js';
import { expectErrors, expectOk } from '../test-support/result.js';
import { formatConfigErrors, loadConfig } from './load.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const { config } = expectOk(loadConfig(validEnv()));

    expect(config.logLevel).toBe('info');
    expect(config.internal).toEqual({ host: '127.0.0.1',
      port: 8090 });
    expect(config.shutdownTimeoutMs).toBe(5000);
    expect(config.healthCheckTimeoutMs).toBe(2000);
    expect(config.hawk.collectorUrl).toBeUndefined();
  });

  it('maps every variable', () => {
    const { config } = expectOk(loadConfig(validEnv({
      LOG_LEVEL: 'debug',
      INTERNAL_HOST: '0.0.0.0',
      INTERNAL_PORT: '9000',
      SHUTDOWN_TIMEOUT_MS: '3000',
      HEALTH_CHECK_TIMEOUT_MS: '1500',
      HAWK_COLLECTOR_URL: 'http://localhost:3000/',
    })));

    expect(config).toEqual({
      instanceId: 'test',
      logLevel: 'debug',
      internal: { host: '0.0.0.0',
        port: 9000 },
      shutdownTimeoutMs: 3000,
      healthCheckTimeoutMs: 1500,
      hawk: {
        apiUrl: 'http://localhost:4000/graphql',
        collectorUrl: 'http://localhost:3000/',
        integrationToken: 'test-token',
        projectId: 'test-project',
        email: 'monitor@example.com',
        password: 'test-password',
      },
    });
  });

  it('names missing required variables', () => {
    const errors = expectErrors(loadConfig({}));

    expect(errors.map(error => error.variable).sort()).toEqual([
      'HAWK_API_URL',
      'HAWK_EMAIL',
      'HAWK_INTEGRATION_TOKEN',
      'HAWK_PASSWORD',
      'HAWK_PROJECT_ID',
      'INSTANCE_ID',
    ]);
    expect(errors.every(error => error.message === 'is required')).toBe(true);
  });

  it('treats empty string as missing', () => {
    const { config } = expectOk(loadConfig(validEnv({ HAWK_COLLECTOR_URL: '' })));

    expect(config.hawk.collectorUrl).toBeUndefined();
  });

  it('empty required is missing', () => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_PASSWORD: '' })));

    expect(errors).toEqual([{ variable: 'HAWK_PASSWORD',
      message: 'is required' }]);
  });

  it.each(['not-a-url', 'localhost:4000/graphql', 'ftp://x'])('rejects non-http URLs: %s', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_API_URL: value })));

    expect(errors.map(error => error.variable)).toEqual(['HAWK_API_URL']);
  });

  it.each(['0', '65536', 'abc'])('rejects bad port: %s', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ INTERNAL_PORT: value })));

    expect(errors).toEqual([{ variable: 'INTERNAL_PORT',
      message: 'must be a port number from 1 to 65535' }]);
  });

  it.each(['Prod', 'a b', 'a'.repeat(33)])('rejects bad instance id: %s', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ INSTANCE_ID: value })));

    expect(errors.map(error => error.variable)).toEqual(['INSTANCE_ID']);
  });

  it('reports all errors at once', () => {
    const errors = expectErrors(loadConfig({ INSTANCE_ID: 'BAD',
      INTERNAL_PORT: '0' }));

    expect(errors).toHaveLength(7);
    expect(errors).toContainEqual({ variable: 'INSTANCE_ID',
      message: 'must be 1-32 characters: a-z, 0-9, -' });
    expect(errors).toContainEqual({ variable: 'INTERNAL_PORT',
      message: 'must be a port number from 1 to 65535' });

    const required = errors.filter(error => error.message === 'is required').map(error => error.variable);

    expect(required.sort()).toEqual([
      'HAWK_API_URL',
      'HAWK_EMAIL',
      'HAWK_INTEGRATION_TOKEN',
      'HAWK_PASSWORD',
      'HAWK_PROJECT_ID',
    ]);
  });

  it('never echoes secret values', () => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_INTEGRATION_TOKEN: 'bad token s3cr3t-probe' })));

    expect(errors.map(error => error.variable)).toEqual(['HAWK_INTEGRATION_TOKEN']);
    expect(JSON.stringify(errors)).not.toContain('s3cr3t-probe');
    expect(formatConfigErrors(errors)).not.toContain('s3cr3t-probe');
  });
});

describe('formatConfigErrors', () => {
  it('formats errors for humans', () => {
    const text = formatConfigErrors([
      { variable: 'INSTANCE_ID',
        message: 'must be 1-32 characters: a-z, 0-9, -' },
      { variable: 'HAWK_PASSWORD',
        message: 'is required' },
    ]);

    expect(text.startsWith('Invalid configuration:\n')).toBe(true);
    expect(text).toContain('  INSTANCE_ID: must be 1-32 characters: a-z, 0-9, -\n');
    expect(text).toContain('  HAWK_PASSWORD: is required\n');
    expect(text.endsWith('See .env.example for all variables.\n')).toBe(true);
  });
});
