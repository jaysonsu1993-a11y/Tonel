#pragma once

#include <string>
#include <vector>
#include <mutex>
#include <cstdint>
#include <cstring>
#include <memory>
#include <unordered_map>

// ============================================================
// WAV file header (44 bytes, standard PCM RIFF format)
// ============================================================

#pragma pack(push, 1)
struct WavHeader {
    char     riff[4]         = {'R','I','F','F'};
    uint32_t file_size;               // total file size - 8
    char     wave[4]         = {'W','A','V','E'};
    char     fmt[4]          = {'f','m','t',' '};
    uint32_t fmt_size        = 16;    // PCM chunk size
    uint16_t audio_format    = 1;     // PCM = 1
    uint16_t num_channels;
    uint32_t sample_rate;
    uint32_t byte_rate;               // sample_rate * num_channels * bits_per_sample / 8
    uint16_t block_align;             // num_channels * bits_per_sample / 8
    uint16_t bits_per_sample;
    char     data[4]         = {'d','a','t','a'};
    uint32_t data_size;               // raw audio bytes
};
#pragma pack(pop)

static_assert(sizeof(WavHeader) == 44, "WavHeader must be 44 bytes");

// ============================================================
// AudioRecorder — thread-safe single-file WAV recorder
//
// Converts interleaved float32 PCM (range [-1.0f, 1.0f]) to
// the configured bit depth and writes to a WAV file.
//
// Thread safety: all public methods are guarded by a mutex,
// making it safe to call from any thread (audio callbacks,
// libuv workers, etc.).
// ============================================================

class AudioRecorder {
public:
    // sampleRate : audio sample rate (default 48000)
    // bitsPerSample: 16 or 24 (default 16)
    // numChannels: 1 = mono, 2 = stereo (default 2)
    AudioRecorder(int sampleRate = 48000,
                  int bitsPerSample = 16,
                  int numChannels = 2);

    ~AudioRecorder();

    // Open a new WAV file and start recording.
    // Returns true on success, false if already recording or file open failed.
    bool startRecording(const std::string& roomId, const std::string& filename);

    // Stop recording and close the file.
    // Flushes any remaining data and updates the WAV header.
    void stopRecording();

    // Append interleaved float audio data.
    // frameCount = number of audio frames (not samples).
    void writeAudio(const float* data, int frameCount, int channels);

    // True while a file is open and recording.
    bool isRecording() const;

    // Returns the path of the currently open recording (empty if not recording).
    std::string getFilePath() const;

private:
    void writeWavHeader();
    void finalizeWav();

    int        sample_rate_;
    int        bits_per_sample_;
    int        num_channels_;
    FILE*      file_ = nullptr;
    std::string file_path_;
    std::string room_id_;
    bool       recording_ = false;

    std::vector<uint8_t> pcm_buffer_; // accumulated PCM bytes before write
    size_t               total_data_bytes_ = 0;

    mutable std::mutex   mutex_;
};

// ============================================================
// RecordingManager — manages multiple concurrent room recordings
//
// Maps roomId -> active AudioRecorder. All access is thread-safe.
// ============================================================

class RecordingManager {
public:
    // Set the directory where recordings are stored (must end with '/').
    // Creates the directory if it does not exist.
    bool setRecordingDir(const std::string& dir);

    // Start a new recording for the given room.
    // Generates a filename like: room_<roomId>_YYYY-MM-DD_HHMMSS.wav
    // Returns the full path of the created file, or empty string on failure.
    std::string startRecording(const std::string& roomId);

    // Stop and finalize the recording for the given room.
    // No-op if the room is not currently recording.
    void stopRecording(const std::string& roomId);

    // Write interleaved float audio frames to the room's recording.
    // No-op if the room is not recording.
    void writeFrames(const std::string& roomId, const float* data, int frames);

    // Returns true if the given room is currently being recorded.
    bool isRecording(const std::string& roomId) const;

    // Returns the paths of all recordings currently managed.
    std::vector<std::string> getRecordings() const;

    // Returns the recording directory path.
    std::string recordingDir() const { std::lock_guard<std::mutex> lock(mutex_); return recording_dir_; }

private:
    std::string recording_dir_ = "./recordings/";
    std::unordered_map<std::string, std::unique_ptr<AudioRecorder>> recorders_;
    mutable std::mutex mutex_;
};
