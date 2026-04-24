// AppState.mm — AppState implementation (thread-safe)
#include "AppState.h"
#import <Foundation/Foundation.h>
#include <algorithm>

// ── Singleton ─────────────────────────────────────────────────────────────────

AppState& AppState::shared() {
    static AppState instance;
    return instance;
}

// ── Participants (mutex-protected) ────────────────────────────────────────────

void AppState::addParticipant(const Participant& p) {
    std::lock_guard<std::mutex> lock(mutex_);
    participants_.push_back(p);
    notifyChange();
}

void AppState::removeParticipant(int id) {
    std::lock_guard<std::mutex> lock(mutex_);
    participants_.erase(
        std::remove_if(participants_.begin(), participants_.end(),
                       [id](const Participant& p) { return p.id == id; }),
        participants_.end());
    notifyChange();
}

void AppState::updateParticipant(const Participant& updated) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& p : participants_) {
        if (p.id == updated.id) {
            p = updated;
            break;
        }
    }
    notifyChange();
}

void AppState::clearParticipants() {
    std::lock_guard<std::mutex> lock(mutex_);
    participants_.clear();
    notifyChange();
}

// ── Notifications ─────────────────────────────────────────────────────────────

void AppState::notifyChange() {
    if (changeCallback_) {
        // Ensure callback fires on the main thread
        if ([NSThread isMainThread]) {
            changeCallback_();
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (this->changeCallback_) this->changeCallback_();
            });
        }
    }
}
