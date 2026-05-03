# Tonel Third-Party Libraries

Third-party dependencies vendored or referenced by the Tonel build.

## miniaudio

- **Location**: `./miniaudio/`
- **Version**: master
- **License**: MIT
- **Website**: https://miniaud.io
- **Purpose**: Lightweight cross-platform audio engine. Vendored from
  the legacy `Tonel-Desktop-AppKit` era. The current macOS client
  (`Tonel-MacOS/`) uses Apple's AVFoundation / Core Audio directly
  and does not depend on miniaudio. Kept here as an option for
  potential future cross-platform desktop work.

## Updating miniaudio

```bash
cd libs
rm -rf miniaudio
curl -L -o miniaudio.zip https://github.com/mackron/miniaudio/archive/refs/heads/master.zip
unzip -o miniaudio.zip
mv miniaudio-master miniaudio
rm miniaudio.zip
```
