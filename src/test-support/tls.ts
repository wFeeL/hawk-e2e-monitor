import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway self-signed certificate. */
export interface SelfSignedCert {
  /** PEM private key. */
  key: string;
  /** PEM certificate. */
  cert: string;
  /** Removes the temporary directory. */
  cleanup(): void;
}

/**
 * Creates a self-signed certificate for `localhost` in a temporary directory.
 * The key stays out of the repository so secret scanners do not see it.
 * @returns Key, certificate and a cleanup function.
 */
export function createSelfSignedCert(): SelfSignedCert {
  const dir = mkdtempSync(join(tmpdir(), 'hawk-e2e-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');

  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });

    return { key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
      cleanup: () => {
        rmSync(dir, { recursive: true,
          force: true });
      } };
  } catch (error) {
    rmSync(dir, { recursive: true,
      force: true });
    throw error;
  }
}
