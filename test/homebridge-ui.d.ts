// Ambient types for the plain-JS homebridge-ui/ files. They ship as-is (no
// build step, no allowJs on the shipped tsconfig) — this only types the
// exports the tests actually import.
//
// Two constraints shape this file:
//  - It must stay a global script (no top-level import/export): a top-level
//    import turns it into a module, and `declare module "..."` inside a
//    module is treated as *augmenting* an existing module rather than
//    declaring a new ambient one.
//  - The module names below use a leading `*` wildcard rather than the
//    literal relative path: TS rejects `declare module "../relative/path"`
//    outright (TS2436, "cannot specify relative module name"). A wildcard
//    ambient module is the supported way to type a real, resolvable file by
//    path suffix.

declare module '*/homebridge-ui/server.js' {
  export interface HttpDependencies {
    fetchImpl?: (url: string, init?: { headers?: Record<string, string>, consoleCert?: string }) => Promise<Response>
    readCert?: (host: string) => Promise<{ pem: string, fingerprint: string }>
  }
  export interface ConsoleCredentials {
    host: string
    apiKey: string
    /** PEM of the trusted console certificate. Nothing is sent without it. */
    consoleCert: string
  }
  export interface ConsoleCertResult {
    pem: string
    fingerprint: string
    trustedFingerprint: string | null
    matches: boolean | null
  }
  export function consoleCertRequest(
    payload?: { host?: string, consoleCert?: string },
    deps?: HttpDependencies,
  ): Promise<ConsoleCertResult>
  export interface TestConnectionResult {
    version: string
    nvrName: string
  }
  export interface DiscoveredDevice {
    id: string
    name: string
    type: string
    hasSpeaker: boolean
    hasMic: boolean
    hasLedStatus: boolean
    hasPackageCamera: boolean
    smartDetectTypes: string[]
  }
  export function testConnectionRequest(
    payload?: Partial<ConsoleCredentials>,
    deps?: HttpDependencies,
  ): Promise<TestConnectionResult>
  export function discoverRequest(
    payload?: Partial<ConsoleCredentials>,
    deps?: HttpDependencies,
  ): Promise<{ devices: DiscoveredDevice[] }>
}

declare module '*/homebridge-ui/public/config-ops.js' {
  export interface Defaults {
    exposeNewDevices: boolean
    quality: string
    hksv: boolean
  }

  export interface DeviceOverride {
    [key: string]: unknown
  }

  export interface ConfigShape {
    platform: string
    name: string
    host: string
    apiKey: string
    defaults: Defaults
    devices: Record<string, DeviceOverride>
    [key: string]: unknown
  }

  export const DEFAULTS: Defaults
  export function ensureConfig(raw?: Partial<ConfigShape> | null): ConfigShape
  export function setDeviceSetting(
    config: ConfigShape,
    deviceId: string,
    key: string,
    value: unknown,
  ): ConfigShape

  export const MAX_STREAMS_RANGE: { min: number, max: number }
  export function parseMaxStreams(raw: unknown): number | undefined
  export function setGlobalSetting(config: ConfigShape, key: string, value: unknown): ConfigShape

  export interface MinimalDomElement {
    tagName: string
    textContent: string
    className: string
  }
  export interface MinimalDocument {
    createElement: (tag: string) => MinimalDomElement
  }
  export function renderDeviceHeader(
    doc: MinimalDocument,
    device: { name?: string, type?: string },
  ): (MinimalDomElement | string)[]

  export const AUDIO_LABEL: string
  export const QUALITY_OPTIONS: [string, string][]
  export function renderQualitySelect(
    doc: MinimalDocument,
    device: { id?: string },
    value?: string,
  ): { wrap: MinimalDomElement, select: MinimalDomElement }
}
