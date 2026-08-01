import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestCert { key: string, cert: string }

/**
 * A real TLS socket is the only thing that can prove certificate pinning
 * works, and TLS needs a certificate. Generated per run into a temp dir rather
 * than checked in, so no private key ever lands in the repo.
 *
 * `CN` is deliberately NOT the address the tests connect to (127.0.0.1): that
 * is the same hostname mismatch the real console has, so these tests exercise
 * the `checkServerIdentity` override rather than accidentally passing without
 * it.
 */
export function makeSelfSigned(cn = 'unifi.local'): TestCert {
  const dir = mkdtempSync(join(tmpdir(), 'protect-tls-test-'))
  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-nodes',
      '-subj',
      `/CN=${cn}`,
    // stderr piped rather than ignored: openssl's progress dots stay out of the
    // test output, but a genuine failure still reports why instead of a bare
    // "Command failed". A missing binary already gives a clear ENOENT.
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
  }
  catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
    throw new Error(`openssl could not generate a test certificate. ${stderr}`, { cause: error })
  }
  finally {
    // finally, so a throw cannot leave a temp dir holding a partial private key.
    rmSync(dir, { recursive: true, force: true })
  }
}
