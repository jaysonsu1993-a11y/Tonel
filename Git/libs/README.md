# S1 第三方库

本目录包含项目依赖的第三方库。

## JUCE

- **位置**: `~/JUCE` (通过 CMake FetchContent 引入)
- **版本**: 8.x (最新)
- **许可证**: JUCE License (商业付费 / GPLv3)
- **官网**: https://juce.com
- **用途**: 音频引擎、GUI、网络

## miniaudio

- **位置**: `./miniaudio/`
- **版本**: master
- **许可证**: MIT (免费，可闭源)
- **官网**: https://miniaud.io
- **用途**: 轻量音频引擎 (可选)

## miniaudio 使用方式

```c
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio/miniaudio.h"

// 播放音频
ma_device_config config = ma_device_config_init(ma_device_type_playback);
config.playback.format   = ma_format_f32;
config.playback.channels  = 2;
config.sampleRate        = 48000;
config.dataCallback       = data_callback;

ma_device device;
ma_device_init(&device, &config, &device);
ma_device_start(&device);
```

## 许可证说明

| 库 | 许可证 | 闭源可用 | 商业可用 |
|----|--------|----------|----------|
| JUCE | GPL/Commercial | ❌ (GPL) / ✅ (付费) | ✅ (付费) |
| miniaudio | MIT | ✅ | ✅ |

## 更新 miniaudio

```bash
cd ~/project-s/band-rehearsal-platform/libs
rm -rf miniaudio
curl -L -o miniaudio.zip https://github.com/mackron/miniaudio/archive/refs/heads/master.zip
unzip -o miniaudio.zip
mv miniaudio-master miniaudio
rm miniaudio.zip
```
