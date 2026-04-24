// NetworkSocket.h - UDP socket for P2P audio streaming
#pragma once

#include <juce_core/juce_core.h>
#include <memory>

class NetworkSocketCallback
{
public:
    virtual ~NetworkSocketCallback() = default;
    virtual void packetReceived(const void* data, int size, const juce::String& senderIP, int senderPort) = 0;
};

class NetworkSocket
{
public:
    NetworkSocket(int port = 8000);
    ~NetworkSocket();
    
    bool bind();
    void close();
    bool isBound() const { return bound; }
    
    int sendTo(const void* data, int size, const juce::String& destIP, int destPort);
    int receive(void* buffer, int maxSize, juce::String& senderIP, int& senderPort);
    
    void setCallback(NetworkSocketCallback* cb) { callback = cb; }
    
private:
    std::unique_ptr<juce::DatagramSocket> socket_;
    int localPort;
    bool bound = false;
    NetworkSocketCallback* callback = nullptr;
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(NetworkSocket)
};
