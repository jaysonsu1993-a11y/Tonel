using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using TonelWindows.App;
using TonelWindows.Network;

namespace TonelWindows.Audio;

public sealed record AudioDeviceInfo(string Id, string Name);

/// <summary>
/// Capture + playback engine for the Windows client. Owns WASAPI Exclusive
/// streams (capture + render) and bridges to MixerClient.
///
/// Pipeline (matches macOS / web behaviour):
///   mic → WasapiExclusiveCapture (48k, any ch/bit) → mono fold-down →
///         re-block to 120-sample frames → PCM16 → MixerClient.SendAudio
///
///   MixerClient.Packet → JitterBuffer per peer → mix in playback IWaveProvider →
///   WasapiOut (Exclusive) → speaker
///
/// Realtime invariants:
///  - capture event-driven (low latency, no GC in hot path on a fresh buffer)
///  - playback IWaveProvider runs on WASAPI render thread
///  - cross-thread mutation through the locks/queues below
/// </summary>
public sealed class AudioEngine : INotifyPropertyChanged
{
    // ── Public observable state ─────────────────────────────────────────────
    private bool _isRunning;
    public bool IsRunning { get => _isRunning; private set { if (_isRunning != value) { _isRunning = value; OnChanged(); } } }

    private float _inputLevel;
    public float InputLevel { get => _inputLevel; private set { if (_inputLevel != value) { _inputLevel = value; OnChanged(); } } }

    public ConcurrentDictionary<string, float> PeerLevels { get; } = new();

    private float _inputGain = 1f;
    public float InputGain { get => _inputGain; set { if (_inputGain != value) { _inputGain = value; OnChanged(); } } }

    private float _outputGain = 1f;
    public float OutputGain { get => _outputGain; set { if (_outputGain != value) { _outputGain = value; OnChanged(); } } }

    private float _monitorGain = 1f;
    public float MonitorGain { get => _monitorGain; set { if (_monitorGain != value) { _monitorGain = value; OnChanged(); } } }

    private bool _monitorMuted;
    public bool MonitorMuted { get => _monitorMuted; set { if (_monitorMuted != value) { _monitorMuted = value; OnChanged(); } } }

    private bool _isMicMuted;
    public bool IsMicMuted { get => _isMicMuted; set { if (_isMicMuted != value) { _isMicMuted = value; OnChanged(); } } }

    public ConcurrentDictionary<string, float> PerPeerGain { get; } = new();
    public ConcurrentDictionary<string, bool> PerPeerMuted { get; } = new();

    private double _actualSampleRate = AudioWire.SampleRate;
    public double ActualSampleRate { get => _actualSampleRate; private set { if (_actualSampleRate != value) { _actualSampleRate = value; OnChanged(); } } }

    private int _captureHwFrames = AudioWire.FrameSamples;
    public int CaptureHwFrames { get => _captureHwFrames; private set { if (_captureHwFrames != value) { _captureHwFrames = value; OnChanged(); } } }

    private int _outputHwFrames = AudioWire.FrameSamples;
    public int OutputHwFrames { get => _outputHwFrames; private set { if (_outputHwFrames != value) { _outputHwFrames = value; OnChanged(); } } }

    private int _deviceInputLatencyMs;
    public int DeviceInputLatencyMs { get => _deviceInputLatencyMs; private set { if (_deviceInputLatencyMs != value) { _deviceInputLatencyMs = value; OnChanged(); } } }

    private int _deviceOutputLatencyMs;
    public int DeviceOutputLatencyMs { get => _deviceOutputLatencyMs; private set { if (_deviceOutputLatencyMs != value) { _deviceOutputLatencyMs = value; OnChanged(); } } }

    public int TxCount { get; private set; }
    public int RxCount { get; private set; }
    public int CaptureClipCount { get; private set; }
    public int SeqGapCount { get; private set; }
    public int RingDropCount { get; private set; }
    public int E2eLatencyMs { get; private set; }

    // ── Live tuning (mirrors macOS) ────────────────────────────────────────
    private int _clientPrimeMin = JitterBuffer.PrimeMin;
    public int ClientPrimeMin
    {
        get => _clientPrimeMin;
        set { if (_clientPrimeMin != value) { _clientPrimeMin = value; JitterBuffer.PrimeMin = value; OnChanged(); } }
    }

    // v6.0.0: defaults raised because frame size shrank 120→32 samples.
    // 8 frames × 0.667 ms ≈ 5 ms steady-state floor; 124 × 0.667 ≈ 82 ms cap
    // matching server default. (Pre-v6: 2 / 8 frames at 2.5ms each.)
    private int _serverJitterTarget = 8;
    public int ServerJitterTarget
    {
        get => _serverJitterTarget;
        set
        {
            if (_serverJitterTarget == value) return;
            _serverJitterTarget = value;
            _mixer?.SendMixerTune(new Dictionary<string, object?> { ["jitter_target"] = value });
            OnChanged();
        }
    }

    private int _serverJitterMaxDepth = 124;
    public int ServerJitterMaxDepth
    {
        get => _serverJitterMaxDepth;
        set
        {
            if (_serverJitterMaxDepth == value) return;
            _serverJitterMaxDepth = value;
            _mixer?.SendMixerTune(new Dictionary<string, object?> { ["jitter_max_depth"] = value });
            OnChanged();
        }
    }

    public void SyncServerTuningFromMixer()
    {
        var m = _mixer;
        if (m == null) return;
        if (_serverJitterTarget != m.ServerJitterTargetFrames)
            ServerJitterTarget = m.ServerJitterTargetFrames;
        if (_serverJitterMaxDepth != m.ServerJitterMaxFrames)
            ServerJitterMaxDepth = m.ServerJitterMaxFrames;
    }

    public int CurrentJitterDepthFrames()
    {
        lock (_peersGate)
        {
            if (_peers.Count == 0) return _clientPrimeMin;
            var sum = _peers.Values.Sum(p => p.Jitter.Depth);
            return sum / _peers.Count;
        }
    }

    // ── Wiring ──────────────────────────────────────────────────────────────
    /// <summary>v6.1.0+ typed as IMixerTransport so transport (UDP/WS/P2P)
    /// can be swapped from Settings without touching the audio path.</summary>
    private IMixerTransport? _mixer;

    private WasapiExclusiveCapture? _capture;
    private WasapiOut? _output;
    private MixerWaveProvider? _waveProvider;
    private MMDevice? _captureDevice;
    private MMDevice? _renderDevice;

    // Self-monitor ring (capture-direct → playback callback). Bounded 5ms.
    private readonly object _monGate = new();
    private readonly Queue<float> _monitorRing = new();
    private const int MonitorRingTrim = 240;     // 5ms @ 48k mono

    // Server self-loopback ring (only consumed when alone in room).
    private readonly object _selfLoopGate = new();
    private readonly Queue<float> _selfLoopRing = new();
    private const int SelfLoopRingTrim = 240;

    // Capture re-blocking — accumulate until we have 120 samples.
    private readonly List<float> _captureAccum = new(256);
    private long _startWallClockMs;

    // Per-peer playback state.
    private sealed class PeerSink { public JitterBuffer Jitter = new(); public float[] LastFrame = Array.Empty<float>(); }
    private readonly Dictionary<string, PeerSink> _peers = new();
    private readonly object _peersGate = new();

    // ── Setup ──────────────────────────────────────────────────────────────

    public void Attach(IMixerTransport mixer)
    {
        if (_mixer != null) _mixer.Packet -= IngestPeerPacket;
        _mixer = mixer;
        _mixer.Packet += IngestPeerPacket;
    }

    public void Start()
    {
        if (IsRunning) return;
        var enumerator = new MMDeviceEnumerator();
        _captureDevice ??= enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        _renderDevice  ??= enumerator.GetDefaultAudioEndpoint(DataFlow.Render,  Role.Communications);

        // ── Capture (WASAPI Exclusive) ─────────────────────────────────────
        var capFmts = PreferredCaptureFormats();
        _capture = new WasapiExclusiveCapture(_captureDevice);
        _capture.Initialize(capFmts, requestedLatencyMs: 3);
        _capture.DataAvailable += OnCaptureData;
        AppLog.Log($"[AudioEngine] capture device: {_captureDevice.FriendlyName} fmt={_capture.WaveFormat.SampleRate}Hz {_capture.WaveFormat.BitsPerSample}bit {_capture.WaveFormat.Channels}ch");

        ActualSampleRate = _capture.WaveFormat.SampleRate;
        if (_capture.WaveFormat.SampleRate != AudioWire.SampleRate)
            AppLog.Log($"[AudioEngine] WARN capture rate {_capture.WaveFormat.SampleRate} != wire rate {AudioWire.SampleRate}; resampling not implemented — set device to 48 kHz");

        // ── Playback (WASAPI Exclusive via NAudio WasapiOut) ───────────────
        // WasapiOut(Exclusive) accepts whatever IWaveProvider format the
        // device supports. We probe and use the first 48k Exclusive format.
        var renderFmt = PickRenderFormat(_renderDevice);
        _waveProvider = new MixerWaveProvider(this, renderFmt);
        _output = new WasapiOut(_renderDevice, AudioClientShareMode.Exclusive, true, /*latency ms*/ 3);
        _output.Init(_waveProvider);
        _output.Play();
        AppLog.Log($"[AudioEngine] render device: {_renderDevice.FriendlyName} fmt={renderFmt.SampleRate}Hz {renderFmt.BitsPerSample}bit {renderFmt.Channels}ch");

        ReadDeviceLatencies();

        _capture.Start();
        _startWallClockMs = NowMs();
        lock (_captureAccum) _captureAccum.Clear();
        IsRunning = true;
        AppLog.Log($"[AudioEngine] started — input lat={DeviceInputLatencyMs}ms output lat={DeviceOutputLatencyMs}ms");
    }

    public void Stop()
    {
        if (!IsRunning) return;
        try { _capture?.Stop(); _capture?.Dispose(); } catch { } _capture = null;
        try { _output?.Stop(); _output?.Dispose(); } catch { } _output = null;
        _waveProvider = null;
        lock (_monGate) _monitorRing.Clear();
        lock (_selfLoopGate) _selfLoopRing.Clear();
        lock (_peersGate) _peers.Clear();
        PeerLevels.Clear();
        IsRunning = false;
    }

    private static WaveFormat[] PreferredCaptureFormats()
    {
        // Try the formats the wire wants first (mono/16-bit) but most
        // consumer interfaces only declare stereo + 24/32-bit Exclusive
        // formats — fold to mono in software.
        return new[]
        {
            new WaveFormat(AudioWire.SampleRate, 16, 1),
            WaveFormat.CreateIeeeFloatWaveFormat(AudioWire.SampleRate, 1),
            new WaveFormat(AudioWire.SampleRate, 16, 2),
            new WaveFormat(AudioWire.SampleRate, 24, 2),
            WaveFormat.CreateIeeeFloatWaveFormat(AudioWire.SampleRate, 2),
        };
    }

    private static WaveFormat PickRenderFormat(MMDevice device)
    {
        var candidates = new[]
        {
            new WaveFormat(AudioWire.SampleRate, 16, 2),
            new WaveFormat(AudioWire.SampleRate, 24, 2),
            WaveFormat.CreateIeeeFloatWaveFormat(AudioWire.SampleRate, 2),
            new WaveFormat(AudioWire.SampleRate, 16, 1),
            WaveFormat.CreateIeeeFloatWaveFormat(AudioWire.SampleRate, 1),
        };
        var client = device.AudioClient;
        foreach (var f in candidates)
        {
            try { if (client.IsFormatSupported(AudioClientShareMode.Exclusive, f)) return f; } catch { }
        }
        throw new NotSupportedException(
            "输出设备不支持任何 48 kHz Exclusive 格式 — 请到系统声音设置确认采样率为 48000 Hz");
    }

    private void ReadDeviceLatencies()
    {
        // WASAPI exposes device period via AudioClient. In Exclusive event
        // mode the period equals the buffer duration we negotiated, so we
        // surface that as both "device" and "buffer" latency. The two
        // numbers used to be split on macOS via CoreAudio HAL; on WASAPI
        // there's only one knob.
        try
        {
            if (_captureDevice != null)
            {
                long defP, minP;
                _captureDevice.AudioClient.GetDevicePeriod(out defP, out minP);
                DeviceInputLatencyMs = (int)Math.Round(defP / 10_000.0);
            }
            if (_renderDevice != null)
            {
                long defP, minP;
                _renderDevice.AudioClient.GetDevicePeriod(out defP, out minP);
                DeviceOutputLatencyMs = (int)Math.Round(defP / 10_000.0);
            }
        }
        catch (Exception e) { AppLog.Log($"[AudioEngine] readDeviceLatencies err: {e.Message}"); }
    }

    // ── Capture path ───────────────────────────────────────────────────────

    private void OnCaptureData(object? sender, WaveInEventArgs e)
    {
        if (_mixer == null || _capture == null) return;
        var fmt = _capture.WaveFormat;
        int channels = fmt.Channels;
        int bytesPerSample = fmt.BitsPerSample / 8;
        bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat
                     || fmt.Encoding == WaveFormatEncoding.Extensible && fmt.BitsPerSample == 32;
        int frames = e.BytesRecorded / fmt.BlockAlign;
        if (frames == 0) return;

        var buf = e.Buffer;
        var mono = new float[frames];
        int clipped = 0;
        float gain = InputGain;

        // Convert to mono float (avg of channels).
        if (isFloat && bytesPerSample == 4)
        {
            unsafe
            {
                fixed (byte* p = buf)
                {
                    var fp = (float*)p;
                    for (int i = 0; i < frames; i++)
                    {
                        float s = 0;
                        for (int c = 0; c < channels; c++) s += fp[i * channels + c];
                        var v = (s / channels) * gain;
                        if (Math.Abs(v) >= 0.999f) clipped++;
                        mono[i] = v;
                    }
                }
            }
        }
        else if (bytesPerSample == 2)
        {
            for (int i = 0; i < frames; i++)
            {
                float s = 0;
                for (int c = 0; c < channels; c++)
                {
                    int idx = (i * channels + c) * 2;
                    short v16 = (short)(buf[idx] | (buf[idx + 1] << 8));
                    s += v16 / 32768f;
                }
                var v = (s / channels) * gain;
                if (Math.Abs(v) >= 0.999f) clipped++;
                mono[i] = v;
            }
        }
        else if (bytesPerSample == 3)
        {
            // 24-bit packed LE
            for (int i = 0; i < frames; i++)
            {
                float s = 0;
                for (int c = 0; c < channels; c++)
                {
                    int idx = (i * channels + c) * 3;
                    int v24 = buf[idx] | (buf[idx + 1] << 8) | (buf[idx + 2] << 16);
                    if ((v24 & 0x800000) != 0) v24 |= unchecked((int)0xFF000000);
                    s += v24 / 8_388_608f;
                }
                var v = (s / channels) * gain;
                if (Math.Abs(v) >= 0.999f) clipped++;
                mono[i] = v;
            }
        }
        else
        {
            return;     // unsupported format
        }

        // Level meter (peak)
        float peak = 0;
        for (int i = 0; i < mono.Length; i++) { var a = Math.Abs(mono[i]); if (a > peak) peak = a; }
        InputLevel = IsMicMuted ? 0 : peak;
        if (clipped > 0) CaptureClipCount += clipped;

        // Self-monitor ring (capture-direct, low latency).
        lock (_monGate)
        {
            for (int i = 0; i < mono.Length; i++) _monitorRing.Enqueue(mono[i]);
            while (_monitorRing.Count > MonitorRingTrim) _monitorRing.Dequeue();
        }

        // If muted, send silence on the wire (keeps mixer's room timing).
        if (IsMicMuted) Array.Clear(mono, 0, mono.Length);

        // Re-block to 120-sample frames and send.
        lock (_captureAccum)
        {
            _captureAccum.AddRange(mono);
            int sent = 0;
            int frameSize = AudioWire.FrameSamples;
            while (_captureAccum.Count >= frameSize)
            {
                var chunk = new float[frameSize];
                _captureAccum.CopyTo(0, chunk, 0, frameSize);
                _captureAccum.RemoveRange(0, frameSize);
                var pcm = PCM16.Encode(chunk);
                var ts = (ushort)(((NowMs() - _startWallClockMs) / 100) & 0xFFFF);
                _mixer.SendAudio(pcm, ts);
                sent++;
            }
            if (sent > 0) TxCount += sent;
        }

        // Debug: surface HW frame count of capture once.
        if (CaptureHwFrames != frames) CaptureHwFrames = frames;
    }

    // ── Playback path ──────────────────────────────────────────────────────

    private void IngestPeerPacket(MixerPacket pkt)
    {
        // userId arrives "room_id:user_id" — strip room prefix for keying.
        var colon = pkt.UserId.IndexOf(':');
        var uid = colon >= 0 ? pkt.UserId.Substring(colon + 1) : pkt.UserId;
        var samples = PCM16.Decode(pkt.Pcm);

        if (uid == _mixer?.UserId)
        {
            // Server self-loopback (alone-in-room mode).
            lock (_selfLoopGate)
            {
                for (int i = 0; i < samples.Length; i++) _selfLoopRing.Enqueue(samples[i]);
                while (_selfLoopRing.Count > SelfLoopRingTrim) _selfLoopRing.Dequeue();
            }
            RxCount++;
            return;
        }

        int gapDelta, dropDelta;
        lock (_peersGate)
        {
            if (!_peers.TryGetValue(uid, out var sink))
            {
                sink = new PeerSink();
                _peers[uid] = sink;
            }
            sink.Jitter.Push(samples, pkt.Sequence);
            sink.LastFrame = samples;
            gapDelta = sink.Jitter.SeqGapCount;
            dropDelta = sink.Jitter.DropOldestCount;
        }

        float peak = 0;
        for (int i = 0; i < samples.Length; i++) { var a = Math.Abs(samples[i]); if (a > peak) peak = a; }
        PeerLevels[uid] = peak;
        RxCount++;
        SeqGapCount = gapDelta;
        RingDropCount = dropDelta;
    }

    /// <summary>Render-side IWaveProvider that mixes peers + monitor + self-loop.</summary>
    internal void FillRender(float[] mixMono, int frameCount)
    {
        // Zero the buffer first.
        Array.Clear(mixMono, 0, frameCount);

        bool hasOtherPeers;
        lock (_peersGate) hasOtherPeers = _peers.Count > 0;

        if (hasOtherPeers)
        {
            // Local monitor mix-in
            var monGain = MonitorMuted ? 0 : MonitorGain;
            if (monGain > 0)
            {
                lock (_monGate)
                {
                    int take = Math.Min(frameCount, _monitorRing.Count);
                    for (int i = 0; i < take; i++) mixMono[i] += _monitorRing.Dequeue() * monGain;
                }
            }
            // Drain self-loopback so it doesn't pile up while unused.
            lock (_selfLoopGate) _selfLoopRing.Clear();
        }
        else
        {
            // Server self-loopback (alone in room → fullMix mode)
            var monGain = MonitorMuted ? 0 : MonitorGain;
            if (monGain > 0)
            {
                lock (_selfLoopGate)
                {
                    int take = Math.Min(frameCount, _selfLoopRing.Count);
                    for (int i = 0; i < take; i++) mixMono[i] += _selfLoopRing.Dequeue() * monGain;
                }
            }
            lock (_monGate) _monitorRing.Clear();
        }

        // Peer mix
        int written = 0;
        int frameSize = AudioWire.FrameSamples;
        while (written < frameCount)
        {
            int take = Math.Min(frameSize, frameCount - written);
            string[] keys;
            lock (_peersGate) keys = _peers.Keys.ToArray();
            foreach (var k in keys)
            {
                float[]? frame;
                lock (_peersGate)
                {
                    if (!_peers.TryGetValue(k, out var sink)) continue;
                    frame = sink.Jitter.Pop();
                    if (frame != null) sink.LastFrame = frame;
                }
                if (frame == null) continue;
                if (PerPeerMuted.TryGetValue(k, out var muted) && muted) continue;
                var g = PerPeerGain.TryGetValue(k, out var pg) ? pg : 1f;
                int n = Math.Min(take, frame.Length);
                for (int i = 0; i < n; i++) mixMono[written + i] += frame[i] * g;
            }
            written += take;
        }

        // Output gain + soft clip
        var og = OutputGain;
        for (int i = 0; i < frameCount; i++)
        {
            var v = mixMono[i] * og;
            if (v > 1f) v = 1f; else if (v < -1f) v = -1f;
            mixMono[i] = v;
        }
    }

    // ── Per-peer controls (UI helpers) ─────────────────────────────────────

    public void SetPeerGain(string uid, float gain)
    {
        PerPeerGain[uid] = gain;
        _mixer?.SendPeerGain(uid, gain);
    }

    public void SetPeerMuted(string uid, bool muted) => PerPeerMuted[uid] = muted;

    // ── Devices ────────────────────────────────────────────────────────────

    public static List<AudioDeviceInfo> ListInputDevices()  => Enumerate(DataFlow.Capture);
    public static List<AudioDeviceInfo> ListOutputDevices() => Enumerate(DataFlow.Render);

    private static List<AudioDeviceInfo> Enumerate(DataFlow flow)
    {
        var list = new List<AudioDeviceInfo>();
        var en = new MMDeviceEnumerator();
        foreach (var d in en.EnumerateAudioEndPoints(flow, DeviceState.Active))
            list.Add(new AudioDeviceInfo(d.ID, d.FriendlyName));
        return list;
    }

    public string? CurrentInputDeviceId  => _captureDevice?.ID;
    public string? CurrentOutputDeviceId => _renderDevice?.ID;

    public void SetInputDevice(string deviceId)
    {
        var en = new MMDeviceEnumerator();
        var d = en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
                  .FirstOrDefault(x => x.ID == deviceId);
        if (d == null) return;
        bool wasRunning = IsRunning;
        if (wasRunning) Stop();
        _captureDevice = d;
        if (wasRunning) Start();
    }

    public void SetOutputDevice(string deviceId)
    {
        var en = new MMDeviceEnumerator();
        var d = en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
                  .FirstOrDefault(x => x.ID == deviceId);
        if (d == null) return;
        bool wasRunning = IsRunning;
        if (wasRunning) Stop();
        _renderDevice = d;
        if (wasRunning) Start();
    }

    // ── E2E latency ────────────────────────────────────────────────────────

    public int ComputeE2eLatencyMs(int audioRttMs, int serverJitterTargetFrames)
    {
        if (audioRttMs < 0 || !IsRunning) return 0;
        var fm = AudioWire.FrameMs;
        var captureBufMs = (double)CaptureHwFrames / AudioWire.SampleRate * 1000.0;
        var outputBufMs  = (double)OutputHwFrames  / AudioWire.SampleRate * 1000.0;
        var serverJitterMs   = Math.Max(0, (serverJitterTargetFrames - 0.5) * fm);
        var serverMixWaitMs  = fm;
        var clientJitterMs   = CurrentJitterDepthFrames() * fm;
        var total = DeviceInputLatencyMs
                  + captureBufMs
                  + audioRttMs
                  + serverJitterMs
                  + serverMixWaitMs
                  + clientJitterMs
                  + outputBufMs
                  + DeviceOutputLatencyMs;
        return (int)Math.Round(total);
    }

    public List<(string Name, int Ms)> E2eBreakdown(int audioRttMs, int serverJitterTargetFrames)
    {
        var fm = AudioWire.FrameMs;
        int cap = (int)Math.Round((double)CaptureHwFrames / AudioWire.SampleRate * 1000.0);
        int outt = (int)Math.Round((double)OutputHwFrames / AudioWire.SampleRate * 1000.0);
        int srvJ = (int)Math.Round(Math.Max(0, (serverJitterTargetFrames - 0.5) * fm));
        int srvT = (int)Math.Round(fm);
        int cliJ = (int)Math.Round(CurrentJitterDepthFrames() * fm);
        return new List<(string, int)>
        {
            ("dev-in",   DeviceInputLatencyMs),
            ("cap-buf",  cap),
            ("net",      Math.Max(0, audioRttMs)),
            ("srv-jit",  srvJ),
            ("srv-tick", srvT),
            ("cli-jit",  cliJ),
            ("out-buf",  outt),
            ("dev-out",  DeviceOutputLatencyMs),
        };
    }

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? n = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

/// <summary>
/// IWaveProvider used by WasapiOut. Receives playback callbacks on the
/// WASAPI render thread; pulls a mixed mono float buffer from the engine
/// then converts to whatever output WaveFormat the device negotiated.
/// </summary>
internal sealed class MixerWaveProvider : IWaveProvider
{
    private readonly AudioEngine _engine;
    private float[]? _mixMono;
    public WaveFormat WaveFormat { get; }

    public MixerWaveProvider(AudioEngine engine, WaveFormat fmt)
    {
        _engine = engine;
        WaveFormat = fmt;
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        var fmt = WaveFormat;
        int bytesPerFrame = fmt.BlockAlign;
        int frames = count / bytesPerFrame;
        if (_mixMono == null || _mixMono.Length < frames) _mixMono = new float[frames];
        _engine.FillRender(_mixMono, frames);

        int channels = fmt.Channels;
        bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat
                     || (fmt.Encoding == WaveFormatEncoding.Extensible && fmt.BitsPerSample == 32);
        int bytesPerSample = fmt.BitsPerSample / 8;

        if (isFloat && bytesPerSample == 4)
        {
            unsafe
            {
                fixed (byte* pb = &buffer[offset])
                {
                    var fp = (float*)pb;
                    for (int i = 0; i < frames; i++)
                    {
                        var v = _mixMono[i];
                        for (int c = 0; c < channels; c++) fp[i * channels + c] = v;
                    }
                }
            }
        }
        else if (bytesPerSample == 2)
        {
            for (int i = 0; i < frames; i++)
            {
                var v = _mixMono[i];
                if (v >  1f) v =  1f; else if (v < -1f) v = -1f;
                short s = (short)(v * 32767f);
                for (int c = 0; c < channels; c++)
                {
                    int idx = offset + (i * channels + c) * 2;
                    buffer[idx]     = (byte)(s & 0xFF);
                    buffer[idx + 1] = (byte)((s >> 8) & 0xFF);
                }
            }
        }
        else if (bytesPerSample == 3)
        {
            for (int i = 0; i < frames; i++)
            {
                var v = _mixMono[i];
                if (v >  1f) v =  1f; else if (v < -1f) v = -1f;
                int s = (int)(v * 8_388_607f);
                for (int c = 0; c < channels; c++)
                {
                    int idx = offset + (i * channels + c) * 3;
                    buffer[idx]     = (byte)(s & 0xFF);
                    buffer[idx + 1] = (byte)((s >> 8) & 0xFF);
                    buffer[idx + 2] = (byte)((s >> 16) & 0xFF);
                }
            }
        }
        return count;
    }
}
