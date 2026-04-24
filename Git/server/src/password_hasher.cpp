#include "password_hasher.h"
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <random>
#include <sstream>
#include <iomanip>
#include <cstring>

// ── Base64 helpers ────────────────────────────────────────────────────────────────

static const char* B64_CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string b64_encode(const unsigned char* data, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        size_t val = data[i] << 16;
        if (i + 1 < len) val |= data[i + 1] << 8;
        if (i + 2 < len) val |= data[i + 2];
        out.push_back(B64_CHARS[(val >> 18) & 0x3F]);
        out.push_back(B64_CHARS[(val >> 12) & 0x3F]);
        out.push_back(i + 1 < len ? B64_CHARS[(val >> 6) & 0x3F] : '=');
        out.push_back(i + 2 < len ? B64_CHARS[val & 0x3F] : '=');
    }
    return out;
}

static std::string b64_decode(const std::string& in) {
    auto lookup = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    std::string out;
    out.reserve((in.size() / 4) * 3);
    int val = 0, valb = -8;
    for (unsigned char c : in) {
        if (c == '=') break;
        int v = lookup(static_cast<char>(c));
        if (v < 0) continue;
        val = (val << 6) + v;
        valb += 6;
        if (valb >= 0) {
            out.push_back(static_cast<char>((val >> valb) & 0xFF));
            valb -= 8;
        }
    }
    return out;
}

// ── PasswordHasher implementation ──────────────────────────────────────────────────────────────────

std::string PasswordHasher::hash_password(const std::string& plaintext) {
    if (plaintext.empty()) return "";
    std::string salt = generate_salt(16);
    if (salt.empty()) return "";
    std::string hash = pbkdf2_sha256(plaintext, salt, 10000, 32);
    if (hash.empty()) return "";
    return b64_encode(reinterpret_cast<const unsigned char*>(salt.data()), salt.size()) +
           ":" +
           b64_encode(reinterpret_cast<const unsigned char*>(hash.data()), hash.size());
}

bool PasswordHasher::verify_password(const std::string& plaintext,
                                      const std::string& stored_hash) {
    if (plaintext.empty() || stored_hash.empty()) return stored_hash.empty() && plaintext.empty();
    size_t sep = stored_hash.find(':');
    if (sep == std::string::npos) return false;
    std::string salt_b64 = stored_hash.substr(0, sep);
    std::string hash_b64 = stored_hash.substr(sep + 1);
    std::string salt = b64_decode(salt_b64);
    std::string expected_hash = pbkdf2_sha256(plaintext, salt, 10000, 32);
    std::string stored_bin = b64_decode(hash_b64);
    if (expected_hash.size() != stored_bin.size()) return false;
    // Constant-time comparison to prevent timing attacks
    unsigned char diff = 0;
    for (size_t i = 0; i < expected_hash.size(); ++i) {
        diff |= static_cast<unsigned char>(expected_hash[i] ^ stored_bin[i]);
    }
    return diff == 0;
}

std::string PasswordHasher::generate_salt(size_t len) {
    std::string salt;
    salt.resize(len);
    if (RAND_bytes(reinterpret_cast<unsigned char*>(&salt[0]), static_cast<int>(len)) != 1) {
        // Fallback to random_device if OpenSSL RAND fails
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_int_distribution<int> dist(0, 255);
        for (size_t i = 0; i < len; ++i) salt[i] = static_cast<char>(dist(gen));
    }
    return salt;
}

std::string PasswordHasher::pbkdf2_sha256(const std::string& pass,
                                           const std::string& salt,
                                           int iterations,
                                           int keylen) {
    std::string out;
    out.resize(keylen);
    int rc = PKCS5_PBKDF2_HMAC(pass.c_str(), static_cast<int>(pass.size()),
                               reinterpret_cast<const unsigned char*>(salt.data()),
                               static_cast<int>(salt.size()),
                               iterations, EVP_sha256(), keylen,
                               reinterpret_cast<unsigned char*>(&out[0]));
    if (rc != 1) return "";
    return out;
}

std::string PasswordHasher::base64_encode(const unsigned char* data, size_t len) {
    return b64_encode(data, len);
}

std::string PasswordHasher::base64_decode(const std::string& encoded) {
    return b64_decode(encoded);
}
