import type { API } from 'homebridge'
import { UniFiProtectPlatform } from './platform.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, UniFiProtectPlatform)
}
