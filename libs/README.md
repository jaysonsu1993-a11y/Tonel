# Tonel Third-Party Libraries

This directory contains third-party dependencies used by Tonel.

## miniaudio

- **Location**: `./miniaudio/`
- **Version**: master
- **License**: MIT (free, can be used in closed-source projects)
- **Website**: https://miniaud.io
- **Purpose**: Lightweight audio engine (used by Tonel-Desktop-AppKit)

## JUCE (Legacy)

- **Location**: `~/JUCE` (fetched via CMake FetchContent)
- **Version**: 8.x
- **License**: JUCE License (commercial paid / GPLv3)
- **Website**: https://juce.com
- **Purpose**: Audio engine, GUI, networking (used by legacy Tonel-Desktop JUCE client only)
- **Status**: Legacy -- AppKit client (miniaudio) is the recommended build

## Usage

```c
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio/miniaudio.h"
```

## License Summary

| Library | License | Closed-Source | Commercial |
|---------|---------|---------------|------------|
| JUCE | GPL/Commercial | No (GPL) / Yes (paid) | Yes (paid) |
| miniaudio | MIT | Yes | Yes |

## Updating miniaudio

```bash
cd libs
rm -rf miniaudio
curl -L -o miniaudio.zip https://github.com/mackron/miniaudio/archive/refs/heads/master.zip
unzip -o miniaudio.zip
mv miniaudio-master miniaudio
rm miniaudio.zip
```
