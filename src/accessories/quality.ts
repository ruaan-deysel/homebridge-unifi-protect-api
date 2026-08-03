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
 * The ONLY size the HKSV recording path advertises, and therefore the only one
 * it may deliver — `recordingArgs` applies no scale filter. Both the
 * advertisement in `recordingOptions` and the recording encoder's
 * no-configuration-yet fallback read this, so those two cannot drift apart.
 * They did once: the ladder was trimmed to 1280x720 while the fallback still
 * said 'high', and a camera whose encoder started before HomeKit sent a
 * configuration recorded 2688x1512.
 *
 * This does NOT make the advertisement true in every case, and claiming so
 * would be worse than the original drift. A per-camera `quality` preference
 * short-circuits `selectQuality` on both branches, so a user who pins `high`
 * still records 2688x1512 against an advertised 1280x720. That is a deliberate
 * trade — a pinned preference is an explicit instruction, and ignoring it would
 * mean someone who pinned `low` to save bandwidth paid for the high substream
 * every minute of every day — but it is a gap in the invariant, not an
 * exception to it.
 */
export const ADVERTISED_RECORDING_SIZE: [number, number] = SUBSTREAM_SIZE.medium

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
