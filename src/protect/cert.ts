import type { PeerCertificate } from 'node:tls'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { connect } from 'node:tls'

export interface ConsoleCert {
  /** PEM text, exactly as it is stored in config.json. */
  pem: string
  /** SHA-256 of the DER bytes, colon-separated — the form UniFi's own UI shows. */
  fingerprint: string
}

function derOf(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]*-----/g, '').replace(/\s+/g, ''), 'base64')
}

function toPem(der: Buffer): string {
  const body = der.toString('base64').replace(/.{1,64}/g, '$&\n')
  return `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`
}

export function fingerprintOf(pem: string): string {
  return createHash('sha256').update(derOf(pem)).digest('hex').toUpperCase().replace(/..(?!$)/g, '$&:')
}

/**
 * TLS options that pin a connection to one specific certificate.
 *
 * READ THIS BEFORE "FIXING" IT. `checkServerIdentity` replaces ONLY the hostname
 * check, and is deliberately NOT a no-op: the console's certificate is issued
 * for the UDM's own hostname while the plugin connects to it by IP address, and
 * that mismatch is the sole reason ordinary verification fails against real
 * hardware. Instead of skipping identity entirely, it re-verifies it by
 * comparing the presented leaf certificate against the trusted one byte for
 * byte, returning an `Error` on any mismatch.
 *
 * Certificate identity is enforced in two layers. `ca: [pem]` makes the
 * console's own certificate the sole trust anchor and `rejectUnauthorized: true`
 * makes node's validator reject anything that does not chain to it — that is the
 * CA check, and it runs first. `checkServerIdentity` then runs and pins the
 * exact leaf byte for byte, which is what replaces the hostname check node would
 * otherwise do at this step. Both run DURING the handshake — before a single
 * byte of the request (the `X-API-KEY` header included) is written to the
 * socket — which is the property that stops a LAN attacker from capturing the
 * credential.
 */
export function pinnedTlsOptions(pem: string) {
  const trusted = derOf(pem)
  return {
    rejectUnauthorized: true,
    ca: [pem],
    checkServerIdentity: (_host: string, cert: PeerCertificate): Error | undefined =>
      cert.raw.equals(trusted)
        ? undefined
        : Object.assign(new Error('The UniFi console presented a certificate that does not match the pinned one.'), { code: 'ERR_TLS_CERT_PIN_MISMATCH' }),
  }
}

/**
 * Reads the certificate the console presents, without trusting it and without
 * sending anything.
 *
 * Verification is deliberately off: the whole point is to see what an untrusted
 * peer offers, either to trust it for the first time or to name it in a
 * mismatch message. Nothing is ever written to this socket — no headers, no API
 * key — and it is destroyed the instant the peer certificate is in hand, so an
 * impostor answering here learns only that someone connected.
 */
export function fetchConsoleCert(host: string, timeoutMs = 10_000): Promise<ConsoleCert> {
  const url = new URL(`https://${host}`)
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || 443),
      rejectUnauthorized: false,
    }, () => {
      const raw = socket.getPeerCertificate().raw
      socket.destroy()
      if (!raw?.length) {
        reject(new Error(`${host} completed a TLS handshake but presented no certificate`))
        return
      }
      const pem = toPem(raw)
      resolve({ pem, fingerprint: fingerprintOf(pem) })
    })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`Timed out reading the certificate of ${host}`)))
    socket.on('error', reject)
  })
}

/**
 * The one place the fail-closed wording lives, so the log and the Homebridge UI
 * cannot drift apart. Carries no credential — fingerprints and a hostname only.
 */
export function certMismatchMessage(host: string, trusted: string, presented: string): string {
  return `The certificate presented by the UniFi console at ${host} does not match the one this plugin trusts, `
    + `so the connection was refused before the API key was sent. `
    + `Trusted: ${trusted}. Presented: ${presented}. `
    + `If you know why it changed — the console was reinstalled, reset, or its certificate regenerated — re-trust it `
    + `deliberately: use "Trust this certificate" in the plugin settings, or delete the "consoleCert" line from the `
    + `UniFiProtect block in config.json and restart Homebridge. If you do not know why it changed, treat it as an `
    + `interception attempt and do not re-trust it.`
}
