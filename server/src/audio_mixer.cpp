// audio_mixer.cpp
// All implementation is inline in audio_mixer.h.
// This file exists to force compilation and to host any future
// non-template, non-inline code.

#include "audio_mixer.h"

// Explicit template instantiations to catch linking errors early
// (not strictly necessary given the inline definitions above, but
// good practice for header-only components used across multiple TUs).

// Currently AudioMixer has no non-inline methods, so this file is minimal.
