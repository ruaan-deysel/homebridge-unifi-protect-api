/**
 * Pure mapping from a HomeKit video resolution request to the Protect substream
 * that best serves it. No HAP, Homebridge, ffmpeg or Protect client imports.
 */

/** The Protect substreams this plugin uses. `package` exists in the API but no camera on the test hardware exposes a package camera, so it is not selected. */
export type Quality = 'low' | 'medium' | 'high'
export type QualityPreference = Quality | 'auto'

/**
 * Measured on the live console (2026-08-01): high 2688x1512, medium 1280x720,
 * low 640x360. HomeKit's most common request is 1280x720, which maps to medium
 * and therefore needs no scaling — only the mandatory HEVC to H.264 transcode.
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
