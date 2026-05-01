#pragma once

#include <string>

// ── Password hashing (PBKDF2-HMAC-SHA256 via OpenSSL) ───────────────────────
//
// Format: base64(salt) + ":" + base64(hash)
// Salt: 16 bytes random
// Iterations: 10000
// Hash: 32 bytes (SHA-256)

class PasswordHasher {
public:
    /// Hash a plaintext password. Returns empty string on failure.
    static std::string hash_password(const std::string& plaintext);

    /// Verify a plaintext password against a stored hash.
    static bool verify_password(const std::string& plaintext, const std::string& stored_hash);

private:
    static std::string generate_salt(size_t len = 16);
    static std::string pbkdf2_sha256(const std::string& pass,
                                      const std::string& salt,
                                      int iterations,
                                      int keylen);
    static std::string base64_encode(const unsigned char* data, size_t len);
    static std::string base64_decode(const std::string& encoded);
};
