// AppState.cpp - Application state management
#include "AppState.h"

void AppState::removeParticipant(int id)
{
    for (auto it = participants.begin(); it != participants.end(); ++it)
    {
        if (it->id == id)
        {
            participants.erase(it);
            return;
        }
    }
}

void AppState::updateParticipant(const Participant& p)
{
    for (auto& existing : participants)
    {
        if (existing.id == p.id)
        {
            existing = p;
            return;
        }
    }
    participants.push_back(p);
}
