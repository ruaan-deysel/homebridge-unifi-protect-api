import type { API } from 'homebridge'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

export default (api: API): void => {
  // Platform is registered in Task 5. Registering nothing here keeps the
  // scaffold loadable by Homebridge without a half-built platform class.
  void api
  void PLATFORM_NAME
  void PLUGIN_NAME
}
