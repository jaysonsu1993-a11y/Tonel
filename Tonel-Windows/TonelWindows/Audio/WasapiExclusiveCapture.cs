using System;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using TonelWindows.App;

namespace TonelWindows.Audio;

/// <summary>
/// WASAPI Exclusive-mode capture. NAudio's built-in WasapiCapture only
/// supports Shared mode — we need Exclusive for ≤5 ms input latency.
/// This thin wrapper drives MMDevice.AudioClient directly with
/// AudioClientShareMode.Exclusive + event-driven I/O.
/// </summary>
public sealed class WasapiExclusiveCapture : IDisposable
{
    private readonly MMDevice _device;
    private AudioClient? _client;
    private AudioCaptureClient? _capture;
    private Thread? _thread;
    private EventWaitHandle? _bufferReady;
    private volatile bool _running;
    private volatile bool _disposed;
    public WaveFormat WaveFormat { get; private set; } = null!;

    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;

    public WasapiExclusiveCapture(MMDevice device) { _device = device; }

    /// <summary>Try formats in priority order; first one IsFormatSupported in
    /// Exclusive mode wins. Throws if none supported.</summary>
    public void Initialize(WaveFormat[] preferredFormats, int requestedLatencyMs = 3)
    {
        _client = _device.AudioClient;
        WaveFormat? chosen = null;
        foreach (var fmt in preferredFormats)
        {
            if (_client.IsFormatSupported(AudioClientShareMode.Exclusive, fmt))
            {
                chosen = fmt;
                break;
            }
        }
        if (chosen == null)
            throw new NotSupportedException(
                "输入设备不支持任何 48kHz Exclusive 格式 — 请在系统声音设置确认采样率为 48000 Hz");

        WaveFormat = chosen;
        // Compute min device period — Exclusive mode demands buffer ≥ device's
        // minimum period. GetDevicePeriod returns ticks (100-ns units).
        long defaultPeriod, minPeriod;
        _client.GetDevicePeriod(out defaultPeriod, out minPeriod);
        long requested = requestedLatencyMs * 10_000L; // ms → 100-ns
        long bufferDuration = Math.Max(requested, minPeriod);

        // Using max(requested, minPeriod) means the buffer should be aligned
        // by definition. If a particular driver still returns
        // AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED (0x88890019), surface it — caller
        // can retry with a different latency value.
        _client.Initialize(AudioClientShareMode.Exclusive,
            AudioClientStreamFlags.EventCallback,
            bufferDuration, bufferDuration, chosen, Guid.Empty);

        _bufferReady = new EventWaitHandle(false, EventResetMode.AutoReset);
        _client.SetEventHandle(_bufferReady.SafeWaitHandle.DangerousGetHandle());
        _capture = _client.AudioCaptureClient;
        AppLog.Log($"[WasapiCap] init exclusive {chosen.SampleRate}Hz {chosen.BitsPerSample}bit {chosen.Channels}ch buf={_client.BufferSize}fr");
    }

    public void Start()
    {
        if (_client == null) throw new InvalidOperationException("not initialized");
        if (_running) return;
        _running = true;
        _client.Start();
        _thread = new Thread(CaptureLoop) { IsBackground = true, Priority = ThreadPriority.Highest, Name = "tonel.wasapi-cap" };
        _thread.Start();
    }

    public void Stop()
    {
        if (!_running) return;
        _running = false;
        _bufferReady?.Set();
        try { _thread?.Join(500); } catch { }
        try { _client?.Stop(); } catch { }
        RecordingStopped?.Invoke(this, new StoppedEventArgs(null));
    }

    private void CaptureLoop()
    {
        Exception? error = null;
        var frameSize = WaveFormat.BlockAlign;
        try
        {
            while (_running)
            {
                if (!_bufferReady!.WaitOne(200)) continue;
                if (!_running) break;
                int packetSize;
                while ((packetSize = _capture!.GetNextPacketSize()) > 0)
                {
                    int framesAvailable;
                    AudioClientBufferFlags flags;
                    var ptr = _capture.GetBuffer(out framesAvailable, out flags);
                    int byteCount = framesAvailable * frameSize;
                    var buf = new byte[byteCount];
                    if ((flags & AudioClientBufferFlags.Silent) != 0)
                    {
                        Array.Clear(buf, 0, buf.Length);
                    }
                    else if (byteCount > 0)
                    {
                        System.Runtime.InteropServices.Marshal.Copy(ptr, buf, 0, byteCount);
                    }
                    _capture.ReleaseBuffer(framesAvailable);
                    if (byteCount > 0)
                        DataAvailable?.Invoke(this, new WaveInEventArgs(buf, byteCount));
                }
            }
        }
        catch (Exception ex) { error = ex; AppLog.Log($"[WasapiCap] loop err: {ex.Message}"); }
        finally
        {
            try { _client?.Stop(); } catch { }
            RecordingStopped?.Invoke(this, new StoppedEventArgs(error));
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
        try { _client?.Dispose(); } catch { }
        _client = null;
        _capture = null;
        _bufferReady?.Dispose();
        _bufferReady = null;
    }
}
