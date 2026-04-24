#include "AudioRecorder.h"

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <sys/stat.h>
#include <sys/types.h>

#ifdef _WIN32
#include <direct.h>
#define mkdir_recursive(path) _mkdir(path)
#else
#include <unistd.h>
#define mkdir_recursive(path) mkdir(path, 0755)
#endif

// ============================================================
// AudioRecorder
// ============================================================

AudioRecorder::AudioRecorder(int sampleRate, int bitsPerSample, int numChannels)
    : sample_rate_(sampleRate)
    , bits_per_sample_(bitsPerSample)
    , num_channels_(numChannels)
{
}

AudioRecorder::~AudioRecorder() {
    stopRecording();
}

bool AudioRecorder::startRecording(const std::string& roomId, const std::string& filename) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (recording_) {
        return false;
    }

    file_path_ = filename;
    room_id_   = roomId;

    file_ = std::fopen(file_path_.c_str(), "wb");
    if (!file_) {
        file_path_.clear();
        return false;
    }

    total_data_bytes_ = 0;

    // Write a placeholder WAV header (fill in file_size/data_size later)
    WavHeader hdr = {};
    std::memset(&hdr, 0, sizeof(hdr));
    hdr.riff[0]         = 'R'; hdr.riff[1] = 'I'; hdr.riff[2] = 'F'; hdr.riff[3] = 'F';
    hdr.wave[0]         = 'W'; hdr.wave[1] = 'A'; hdr.wave[2] = 'V'; hdr.wave[3] = 'E';
    hdr.fmt[0]          = 'f'; hdr.fmt[1]  = 'm'; hdr.fmt[2]  = 't'; hdr.fmt[3]  = ' ';
    hdr.fmt_size        = 16;
    hdr.audio_format    = 1; // PCM
    hdr.num_channels    = static_cast<uint16_t>(num_channels_);
    hdr.sample_rate     = static_cast<uint32_t>(sample_rate_);
    hdr.bits_per_sample = static_cast<uint16_t>(bits_per_sample_);
    hdr.block_align     = static_cast<uint16_t>(num_channels_ * bits_per_sample_ / 8);
    hdr.byte_rate       = hdr.sample_rate * hdr.block_align;
    hdr.data[0]         = 'd'; hdr.data[1] = 'a'; hdr.data[2] = 't'; hdr.data[3] = 'a';

    if (std::fwrite(&hdr, sizeof(hdr), 1, file_) != 1) {
        std::fclose(file_);
        file_ = nullptr;
        file_path_.clear();
        return false;
    }

    recording_ = true;
    return true;
}

void AudioRecorder::stopRecording() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!recording_) return;

    recording_ = false;
    finalizeWav();

    if (file_) {
        std::fclose(file_);
        file_ = nullptr;
    }
    file_path_.clear();
    room_id_.clear();
    pcm_buffer_.clear();
}

void AudioRecorder::writeAudio(const float* data, int frameCount, int channels) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!recording_ || !file_) return;

    for (int i = 0; i < frameCount * channels; ++i) {
        float s = data[i];
        s = std::max(-1.0f, std::min(1.0f, s)); // clamp

        if (bits_per_sample_ == 16) {
            int16_t v = static_cast<int16_t>(s * 32767.0f);
            uint8_t bytes[2] = {
                static_cast<uint8_t>( v        & 0xFF),
                static_cast<uint8_t>((v >> 8)   & 0xFF),
            };
            pcm_buffer_.insert(pcm_buffer_.end(), bytes, bytes + 2);
        } else if (bits_per_sample_ == 24) {
            int32_t v = static_cast<int32_t>(s * 8388607.0f);
            uint8_t bytes[3] = {
                static_cast<uint8_t>( v        & 0xFF),
                static_cast<uint8_t>((v >> 8)  & 0xFF),
                static_cast<uint8_t>((v >> 16)  & 0xFF),
            };
            pcm_buffer_.insert(pcm_buffer_.end(), bytes, bytes + 3);
        }
    }

    // Flush every ~0.5 s of audio to avoid unbounded memory growth
    // (48kHz * 2ch * 2 bytes = 192000 bytes/sec → flush at 96000)
    if (pcm_buffer_.size() >= 96000) {
        if (std::fwrite(pcm_buffer_.data(), 1, pcm_buffer_.size(), file_) != pcm_buffer_.size()) {
            recording_ = false;
            return;
        }
        total_data_bytes_ += pcm_buffer_.size();
        pcm_buffer_.clear();
    }
}

bool AudioRecorder::isRecording() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return recording_;
}

std::string AudioRecorder::getFilePath() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return file_path_;
}

void AudioRecorder::finalizeWav() {
    if (!file_) return;

    // Flush remaining PCM data
    if (!pcm_buffer_.empty()) {
        std::fwrite(pcm_buffer_.data(), 1, pcm_buffer_.size(), file_);
        total_data_bytes_ += pcm_buffer_.size();
        pcm_buffer_.clear();
    }

    // Update file_size and data_size in the WAV header
    std::rewind(file_);

    uint32_t data_size = static_cast<uint32_t>(total_data_bytes_);
    uint32_t file_size = 4 + sizeof(WavHeader) - 8 + data_size;

    WavHeader hdr = {};
    std::memset(&hdr, 0, sizeof(hdr));
    hdr.riff[0]         = 'R'; hdr.riff[1] = 'I'; hdr.riff[2] = 'F'; hdr.riff[3] = 'F';
    hdr.wave[0]         = 'W'; hdr.wave[1] = 'A'; hdr.wave[2] = 'V'; hdr.wave[3] = 'E';
    hdr.fmt[0]          = 'f'; hdr.fmt[1]  = 'm'; hdr.fmt[2]  = 't'; hdr.fmt[3]  = ' ';
    hdr.fmt_size        = 16;
    hdr.audio_format    = 1;
    hdr.num_channels    = static_cast<uint16_t>(num_channels_);
    hdr.sample_rate     = static_cast<uint32_t>(sample_rate_);
    hdr.bits_per_sample = static_cast<uint16_t>(bits_per_sample_);
    hdr.block_align     = static_cast<uint16_t>(num_channels_ * bits_per_sample_ / 8);
    hdr.byte_rate       = hdr.sample_rate * hdr.block_align;
    hdr.data[0]         = 'd'; hdr.data[1] = 'a'; hdr.data[2] = 't'; hdr.data[3] = 'a';

    // Patch sizes into RIFF and data chunks (little-endian, native format)
    std::fseek(file_, 4, SEEK_SET);
    std::fwrite(&file_size, 4, 1, file_);

    std::fseek(file_, 40, SEEK_SET);
    std::fwrite(&data_size, 4, 1, file_);

    std::fflush(file_);
}

// ============================================================
// RecordingManager
// ============================================================

bool RecordingManager::setRecordingDir(const std::string& dir) {
    std::lock_guard<std::mutex> lock(mutex_);
    recording_dir_ = dir;
    if (!recording_dir_.empty() && recording_dir_.back() != '/') {
        recording_dir_ += '/';
    }
    // Try to create the directory recursively
    if (mkdir_recursive(recording_dir_.c_str()) != 0 && errno != EEXIST) {
        return false;
    }
    return true;
}

std::string RecordingManager::startRecording(const std::string& roomId) {
    std::lock_guard<std::mutex> lock(mutex_);

    // Stop existing recording for this room
    if (recorders_.find(roomId) != recorders_.end()) {
        recorders_[roomId]->stopRecording();
        recorders_.erase(roomId);
    }

    // Build filename: room_<roomId>_YYYY-MM-DD_HHMMSS.wav
    std::time_t now = std::time(nullptr);
    std::tm tm_buf;
#ifdef _WIN32
    std::tm* tm_info = localtime_s(&tm_buf, &now) == 0 ? &tm_buf : nullptr;
#else
    std::tm* tm_info = localtime_r(&now, &tm_buf);
#endif
    if (!tm_info) return {};

    char time_buf[64];
    std::strftime(time_buf, sizeof(time_buf), "%Y-%m-%d_%H%M%S", tm_info);

    std::string dir = recording_dir_;
    if (mkdir_recursive(dir.c_str()) != 0 && errno != EEXIST) {
        return {};
    }

    std::string filename = dir + "room_" + roomId + "_" + time_buf + ".wav";

    auto recorder = std::make_unique<AudioRecorder>(48000, 16, 2);
    if (!recorder->startRecording(roomId, filename)) {
        return {};
    }

    recorders_[roomId] = std::move(recorder);
    return filename;
}

void RecordingManager::stopRecording(const std::string& roomId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = recorders_.find(roomId);
    if (it != recorders_.end()) {
        it->second->stopRecording();
        recorders_.erase(it);
    }
}

void RecordingManager::writeFrames(const std::string& roomId, const float* data, int frames) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = recorders_.find(roomId);
    if (it != recorders_.end()) {
        it->second->writeAudio(data, frames, 2); // channels = 2 (stereo)
    }
}

bool RecordingManager::isRecording(const std::string& roomId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = recorders_.find(roomId);
    return it != recorders_.end() && it->second->isRecording();
}

std::vector<std::string> RecordingManager::getRecordings() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::string> result;
    for (const auto& kv : recorders_) {
        if (kv.second->isRecording()) {
            result.push_back(kv.second->getFilePath());
        }
    }
    return result;
}
