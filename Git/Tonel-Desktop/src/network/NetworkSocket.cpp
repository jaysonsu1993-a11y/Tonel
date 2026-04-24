// NetworkSocket.cpp - UDP socket implementation
#include "NetworkSocket.h"

NetworkSocket::NetworkSocket(int port)
    : localPort(port)
{
    socket_ = std::make_unique<juce::DatagramSocket>();
}

NetworkSocket::~NetworkSocket()
{
    // unique_ptr destructor handles cleanup
}

bool NetworkSocket::bind()
{
    if (!socket_)
        return false;

    bound = socket_->bindToPort(localPort);
    if (bound)
    {
        printf("Network socket bound to port %d\n", localPort);
    }
    else
    {
        printf("Failed to bind socket to port %d\n", localPort);
    }
    return bound;
}

void NetworkSocket::close()
{
    // In JUCE 8, socket is closed by destructor
    // Explicit close not available, just mark as unbound
    bound = false;
    printf("Network socket closed\n");
}

int NetworkSocket::sendTo(const void* data, int size, const juce::String& destIP, int destPort)
{
    if (!socket_ || !bound)
        return -1;

    return socket_->write(destIP, destPort, data, size);
}

int NetworkSocket::receive(void* buffer, int maxSize, juce::String& senderIP, int& senderPort)
{
    if (!socket_ || !bound)
        return -1;

    // Non-blocking read (false for last parameter)
    return socket_->read(buffer, maxSize, false, senderIP, senderPort);
}
