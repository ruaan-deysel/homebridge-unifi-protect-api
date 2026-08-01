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
 * READ THIS BEFORE "FIXING" IT. `checkServerIdentity` is overridden to skip the
 * HOSTNAME check and nothing else: the console's certificate is issued for the
 * UDM's own hostname while the plugin connects to it by IP address, and that
 * mismatch is the sole reason ordinary verification fails against real hardware.
 * Certificate identity is still fully enforced — `rejectUnauthorized: true`
 * plus the console's own certificate as the only trust anchor means node's
 * validator rejects any certificate but this exact one, during the handshake,
 * before a single byte of the request (the `X-API-KEY` header included) is
 * written to the socket. That is the property that stops a LAN attacker from
 * capturing the credential, and it is why post-handshake fingerprint comparison
 * is NOT used here: by the time such a check could run, the headers are gone.
 */
export function pinnedTlsOptions(pem: string) {
  return {
    rejectUnauthorized: true,
    ca: [pem],
    checkServerIdentity: () => undefined,
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
