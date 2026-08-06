# Homebridge UniFi Protect

[![npm](https://img.shields.io/npm/v/homebridge-unifi-protect-api/latest?label=latest)](https://www.npmjs.com/package/homebridge-unifi-protect-api)
[![GitHub release](https://img.shields.io/github/release/ruaan-deysel/homebridge-unifi-protect-api.svg)](https://github.com/ruaan-deysel/homebridge-unifi-protect-api/releases)
[![npm](https://img.shields.io/npm/dt/homebridge-unifi-protect-api)](https://www.npmjs.com/package/homebridge-unifi-protect-api)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Bring UniFi Protect cameras into Apple Home using Ubiquiti's official Integration API.

## What it does

- Live video and snapshots
- HomeKit Secure Video with pre-motion recording
- Motion, smart detection, smoke, carbon monoxide, and doorbell sensors
- Camera status LED control
- Package-camera live view and snapshots
- Optional camera audio and two-way talkback
- Protect floodlights as a dimmable light with a motion sensor
- Chime volume control as a HomeKit light

## Requirements

- Homebridge 2
- Node.js 22 or 24
- UniFi Protect with the Integration API enabled
- ffmpeg

Tested with UniFi Protect 7.1.87. Hardware video encoding is recommended for multiple cameras.

## Installation

1. Search for **Homebridge UniFi Protect** in the Homebridge UI and install it.
2. Create an API key under **Integrations** in UniFi Site Manager.
3. Enter the console address and API key in the plugin settings.
4. Select **Test Connection**, save, and restart Homebridge (or the plugin's child bridge).

## Configuration

Use **Defaults** for shared settings and **Devices** for camera-specific options. The device list
appears after a successful connection test.

The plugin remembers the console certificate after the first connection. If it changes later,
the plugin refuses to connect until you deliberately trust the new certificate.

## HomeKit Secure Video

HKSV is disabled by default and enabled per camera. It requires a supported iCloud+ plan
and an Apple home hub (HomePod or Apple TV). Hardware video encoding is recommended when
recording several cameras.

## Troubleshooting

- **Connection or certificate error:** confirm the console address and API key. Trust a changed
  certificate only when you can explain why it changed.
- **Camera not responding:** confirm ffmpeg is installed and restart Homebridge (or the plugin's child bridge).
- **High CPU usage:** enable hardware video encoding or reduce concurrent live views.
- **Missing HKSV clips:** confirm HKSV is enabled for that camera, your Apple home hub is
  configured, and your iCloud+ plan supports it.
- **Blank device list:** select **Test Connection** first.

## Known limitations

The official Integration API does not currently provide recording-mode control, privacy zones,
or event thumbnails.

## Support

[Report a problem or request a feature](https://github.com/ruaan-deysel/homebridge-unifi-protect-api/issues).

## License

[Apache 2.0](LICENSE)
