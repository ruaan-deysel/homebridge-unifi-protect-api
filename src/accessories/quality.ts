/**
 * Pure mapping from a HomeKit video resolution request to the Protect substream
 * that best serves it. No HAP, Homebridge, ffmpeg or Protect client imports.
 */

/** The Protect substreams this plugin uses. `package` exists in the API but no camera on the test hardware exposes a package camera, so it is not selected. */
export type Quality = 'low' | 'medium' | 'high'
export type QualityPreference = Quality | 'auto'

/**
 * What each substream actually measures on the live console (2026-08-01).
 * Exported because the recording path advertises resolutions to HomeKit and
 * applies NO scale filter, so an advertised size is only honest if the
 * substream `selectQuality` picks for it is exactly that size. A test pins the
 * advertised recording ladder against this table; a copy of these numbers
 * anywhere else would drift out of agreement with the console silently.
 */
export const SUBSTREAM_SIZE: Record<Quality, [number, number]> = {
  high: [2688, 1512],
  medium: [1280, 720],
  low: [640, 360],
}

/**
 * The ONE substream the HKSV recording path opens, for every camera and every
 * negotiated configuration. `recordingArgs` applies no scale filter, so what
 * this substream measures is exactly what HomeKit receives.
 */
export const ADVERTISED_RECORDING_QUALITY: Quality = 'medium'

/**
 * The ONLY size the HKSV recording path advertises, and — because it is derived
 * from the substream the encoder actually opens rather than chosen beside it —
 * the only one it can deliver. The advertisement in `recordingOptions` and the
 * encoder in `startEncoder` both read the constants above, so they cannot drift
 * apart. They did once: the ladder was trimmed to 1280x720 while the fallback
 * still said 'high', and a camera whose encoder started before HomeKit sent a
 * configuration recorded 2688x1512.
 *
 * A per-camera `quality` preference no longer reaches this path at all. It used
 * to short-circuit `selectQuality`, so a user who pinned `high` recorded
 * 2688x1512 against an advertised 1280x720 — and there is no honest way to
 * advertise that instead: 2688x1512 is 15960 macroblocks, and HomeKit's HKSV
 * level set stops at Level 4.0 (8192). The preference still governs live view,
 * where scaling and the full ladder are available.
 */
export const ADVERTISED_RECORDING_SIZE: [number, number] = SUBSTREAM_SIZE[ADVERTISED_RECORDING_QUALITY]

/**
 * HomeKit's most common request is 1280x720, which maps to medium and therefore
 * needs no scaling — only the mandatory HEVC to H.264 transcode.
 */
export function selectQuality(width: number, height: number, preference?: QualityPreference): Quality {
  if (preference === 'low' || preference === 'medium' || preference === 'high')
    return preference
  if (width <= 640 && height <= 360)
    return 'low'
  if (width <= 1280 && height <= 720)
    return 'medium'
  return 'high'
}
