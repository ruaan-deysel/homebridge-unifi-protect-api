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
  export type IcloudTier = '50gb' | '200gb' | '2tb'

  export interface Defaults {
    exposeNewDevices: boolean
    quality: string
    hksv: boolean
    icloudTier: IcloudTier
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
  export const RECORDING_LIMITS: Record<IcloudTier, number>
  export function ensureConfig(raw?: Partial<ConfigShape> | null): ConfigShape
  export function parseIcloudTier(raw: unknown): IcloudTier
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
  export const TALKBACK_LABEL: string
  export const QUALITY_OPTIONS: [string, string][]
  export function renderQualitySelect(
    doc: MinimalDocument,
    device: { id?: string },
    value?: string,
  ): { wrap: MinimalDomElement, select: MinimalDomElement }

  export const PACKAGE_LABEL: string
  export function shouldOfferPackageCamera(device: { type?: string, hasPackageCamera?: boolean }): boolean
  export function renderToggle(
    doc: MinimalDocument,
    id: string,
    label: string,
  ): { wrap: MinimalDomElement, input: MinimalDomElement }

  export function defaultFor(config: ConfigShape, key: string): unknown
  export function cameraToggles(
    device: { type?: string, hasMic?: boolean, hasSpeaker?: boolean, hasPackageCamera?: boolean },
  ): { key: string, label: string, comingLater?: boolean, section: 'Live view' | 'Recording' | 'Extra accessories' }[]
}

declare module '*/homebridge-ui/public/ui-render.js' {
  export interface MinimalDomElement {
    tagName: string
    id: string
    textContent: string
    className: string
    style: { display: string }
    attributes: Record<string, string>
    dataset: Record<string, string>
    tabIndex: number
    setAttribute: (name: string, value: string) => void
    addEventListener: (type: 'click' | 'keydown', handler: (event: { key?: string }) => void) => void
    focus: () => void
  }
  export interface MinimalDocument {
    createElement: (tag: string) => MinimalDomElement
  }
  export function renderTabs(
    doc: MinimalDocument,
    labels: string[],
  ): {
    tablist: MinimalDomElement
    panes: MinimalDomElement[]
    buttons: MinimalDomElement[]
    select: (index: number, options?: { focus?: boolean }) => void
  }

  export interface ListedDevice {
    id: string
    name: string
    type: string
  }
  export function renderDeviceList(
    doc: MinimalDocument,
    devices: ListedDevice[],
    onSelect: (id: string) => void,
  ): {
    list: MinimalDomElement
    filter: (term: string) => void
    rows: () => MinimalDomElement[]
  }

  export function renderDetail(
    doc: MinimalDocument,
    device: { name: string },
  ): {
    pane: MinimalDomElement
    heading: MinimalDomElement
    bodies: Record<'General' | 'Live view' | 'Recording' | 'Extra accessories', MinimalDomElement>
  }
}
