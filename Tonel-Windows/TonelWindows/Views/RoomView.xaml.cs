using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using TonelWindows.App;
using TonelWindows.Audio;
using TonelWindows.Models;

namespace TonelWindows.Views;

public partial class RoomView : UserControl
{
    private readonly AppState _state;
    private readonly DispatcherTimer _poll;

    private ChannelStripView? _selfStrip;
    private double _monitorVolume = 100;
    private bool _monitorMuted;

    private readonly Dictionary<string, ChannelStripView> _peerStrips = new();
    private readonly Dictionary<string, double> _peerVolumes = new();
    private readonly Dictionary<string, bool> _peerMuted = new();
    private readonly Dictionary<string, bool> _peerSoloed = new();

    private sealed class InputChannel
    {
        public string Id = "";
        public string DeviceId = "";
        public double Volume = 100;
        public bool Muted;
        public InputChannelStripView? View;
    }
    private readonly List<InputChannel> _inputs = new() { new() { Id = "ch-0" } };
    private List<AudioDeviceInfo> _inputDevices = new();

    private DateTime _lastClickTs = DateTime.MinValue;
    private int _clickCount;

    public RoomView(AppState state)
    {
        InitializeComponent();
        _state = state;
        _poll = new DispatcherTimer(TimeSpan.FromMilliseconds(100), DispatcherPriority.Normal,
            (_, __) => Tick(), Dispatcher);
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        _state.Peers.CollectionChanged += (_, __) => Dispatcher.Invoke(RebuildMixer);
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        RoomIdText.Text = _state.CurrentRoomId;
        _inputDevices = AudioEngine.ListInputDevices();
        BuildSelfStrip();
        RebuildMixer();
        BuildInputs();
        UpdateMicBtn();
        UpdateReturnHomeBtn();
        _state.PropertyChanged += OnAppStateChanged;
        _poll.Start();
    }

    private void OnAppStateChanged(object? sender, PropertyChangedEventArgs e)
    {
        Dispatcher.Invoke(() =>
        {
            switch (e.PropertyName)
            {
                case nameof(AppState.CurrentRoomId):
                    RoomIdText.Text = _state.CurrentRoomId;
                    UpdateReturnHomeBtn();
                    break;
                case nameof(AppState.MyRoomId):
                case nameof(AppState.IsJoining):
                    UpdateReturnHomeBtn();
                    break;
            }
        });
    }

    private void UpdateReturnHomeBtn()
    {
        bool show = !string.IsNullOrEmpty(_state.CurrentRoomId)
                 && _state.CurrentRoomId != _state.MyRoomId
                 && !_state.IsJoining;
        ReturnHomeBtn.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnUnloaded(object sender, RoutedEventArgs e) => _poll.Stop();

    private void Tick()
    {
        // Pull engine values for UI re-render.
        if (_selfStrip != null) _selfStrip.Level = _state.Audio.InputLevel;

        var levels = _state.Audio.PeerLevels;
        foreach (var kv in _peerStrips)
            kv.Value.Level = levels.TryGetValue(kv.Key, out var v) ? v : 0;

        var rtt = _state.Mixer.AudioRttMs;
        var e2e = _state.Audio.ComputeE2eLatencyMs(rtt, _state.Mixer.ServerJitterTargetFrames);
        E2eText.Text = e2e > 0 ? $"{e2e}ms" : "--";
        E2eText.Foreground = LatencyBrush(e2e <= 0 ? -1 : e2e, 100, 200);
        RttText.Text = rtt >= 0 ? $"{rtt}ms" : "--";
        RttText.Foreground = LatencyBrush(rtt < 0 ? -1 : rtt, 50, 100);

        // Detect new peers from audio side too (LEVELS arrival before signaling PEER_JOINED).
        foreach (var k in levels.Keys)
            if (k != _state.UserId && !_peerStrips.ContainsKey(k))
                AddPeerStrip(k);

        // Debug line
        var bd = _state.Audio.E2eBreakdown(rtt, _state.Mixer.ServerJitterTargetFrames);
        var bdStr = string.Join(" ", bd.Select(x => $"{x.Name}={x.Ms}"));
        var muteFlag = _state.Audio.IsMicMuted ? " MUTED" : "";
        DebugLine.Text = $"uid={Snip(_state.UserId, 14)} peers={_state.Peers.Count} sr={(int)_state.Audio.ActualSampleRate} " +
                        $"tx={_state.Audio.TxCount} rx={_state.Audio.RxCount} clip={_state.Audio.CaptureClipCount} " +
                        $"gap={_state.Audio.SeqGapCount} drop={_state.Audio.RingDropCount}{muteFlag} | e2e: {bdStr}";

        // Banner: bluetooth/high latency hint
        if (_state.Audio.DeviceOutputLatencyMs > 30)
        {
            BannerHost.Background = new SolidColorBrush(Color.FromRgb(0x3B, 0x29, 0x0D));
            BannerText.Text = $"⚠ 检测到高延迟输出设备（约 {_state.Audio.DeviceOutputLatencyMs}ms）。建议改用有线耳机或 USB 声卡。";
            BannerHost.Visibility = Visibility.Visible;
        }
        else
        {
            BannerHost.Visibility = Visibility.Collapsed;
        }

        UpdateCountLabels();
    }

    private static string Snip(string s, int n) => s.Length <= n ? s : s.Substring(0, n);

    private static Brush LatencyBrush(int ms, int good, int ok)
    {
        if (ms < 0) return new SolidColorBrush(Color.FromRgb(0x80, 0x80, 0x80));
        if (ms < good) return new SolidColorBrush(Color.FromRgb(0x22, 0xC5, 0x5E));
        if (ms < ok) return new SolidColorBrush(Color.FromRgb(0xEA, 0xB3, 0x08));
        return new SolidColorBrush(Color.FromRgb(0xEF, 0x44, 0x44));
    }

    // ── Mixer section ─────────────────────────────────────────────────────

    private void BuildSelfStrip()
    {
        var strip = new ChannelStripView
        {
            Title = "YOU · Mon",
            IsSelf = true,
            ShowSolo = false,
            Volume = _monitorVolume,
            Muted = _monitorMuted,
            Margin = new Thickness(0, 0, 10, 0),
        };
        strip.VolumeChanged += v =>
        {
            _monitorVolume = v;
            _state.Audio.MonitorGain = (float)(v / 100.0);
        };
        strip.MuteChanged += m =>
        {
            _monitorMuted = m;
            _state.Audio.MonitorMuted = m;
        };
        _selfStrip = strip;
        MixerStrips.Children.Insert(0, strip);
    }

    private void RebuildMixer()
    {
        // Remove vanished peers
        var current = UnionPeerIds();
        var toRemove = _peerStrips.Keys.Where(k => !current.Contains(k)).ToList();
        foreach (var k in toRemove)
        {
            MixerStrips.Children.Remove(_peerStrips[k]);
            _peerStrips.Remove(k);
        }
        foreach (var uid in current)
            if (!_peerStrips.ContainsKey(uid)) AddPeerStrip(uid);
        UpdateCountLabels();
    }

    private HashSet<string> UnionPeerIds()
    {
        var ids = new HashSet<string>(_state.Peers.Select(p => p.UserId));
        foreach (var k in _state.Audio.PeerLevels.Keys)
            if (k != _state.UserId) ids.Add(k);
        ids.Remove(_state.UserId);
        return ids;
    }

    private void AddPeerStrip(string uid)
    {
        var strip = new ChannelStripView
        {
            Title = uid.Length > 8 ? uid.Substring(uid.Length - 8) : uid,
            IsSelf = false,
            Volume = _peerVolumes.TryGetValue(uid, out var v) ? v : 100,
            Muted = _peerMuted.TryGetValue(uid, out var m) && m,
            Soloed = _peerSoloed.TryGetValue(uid, out var s) && s,
            Margin = new Thickness(0, 0, 10, 0),
        };
        strip.VolumeChanged += val =>
        {
            _peerVolumes[uid] = val;
            _state.Audio.SetPeerGain(uid, (float)(val / 100.0));
        };
        strip.MuteChanged += mu =>
        {
            _peerMuted[uid] = mu;
            _state.Audio.SetPeerMuted(uid, mu);
        };
        strip.SoloChanged += so =>
        {
            _peerSoloed[uid] = so;
            // Solo behaviour: when soloing self/uid, clamp own output to 0
            // (web parity for the simple case — full solo bus is a TODO).
            _state.Audio.OutputGain = (so && uid == _state.UserId) ? 0 : 1;
        };
        _peerStrips[uid] = strip;
        MixerStrips.Children.Add(strip);
    }

    // ── Input tracks section ──────────────────────────────────────────────

    private void BuildInputs()
    {
        InputStrips.Children.Clear();
        for (int i = 0; i < _inputs.Count; i++)
        {
            var idx = i;
            var ch = _inputs[idx];
            var view = new InputChannelStripView
            {
                ChannelLabel = $"MIC {idx + 1}",
                InputDevices = _inputDevices,
                SelectedDeviceId = ch.DeviceId,
                CanRemove = _inputs.Count > 1,
                Volume = ch.Volume,
                Muted = ch.Muted,
                Margin = new Thickness(0, 0, 10, 0),
            };
            view.DeviceChanged += id =>
            {
                ch.DeviceId = id;
                if (idx == 0 && !string.IsNullOrEmpty(id))
                {
                    try { _state.Audio.SetInputDevice(id); }
                    catch (Exception ex) { _state.LastError = "切换输入失败：" + ex.Message; }
                }
            };
            view.Removed += () =>
            {
                _inputs.RemoveAt(idx);
                BuildInputs();
            };
            view.VolumeChanged += v =>
            {
                ch.Volume = v;
                if (idx == 0) _state.Audio.InputGain = (float)(v / 100.0);
            };
            view.MuteChanged += m =>
            {
                ch.Muted = m;
                if (idx == 0) _state.Audio.IsMicMuted = m;
            };
            ch.View = view;
            InputStrips.Children.Add(view);
        }

        var addBtn = new Button
        {
            Content = "＋ 添加输入",
            Width = 96, Height = 280,
            Margin = new Thickness(0, 22, 0, 0),
            FontSize = 13,
            Background = new SolidColorBrush(Color.FromRgb(0x1A, 0x3B, 0x1A)),
            Foreground = new SolidColorBrush(Color.FromRgb(0x9E, 0xF2, 0x9E)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(0x4A, 0x7A, 0x4A)),
            BorderThickness = new Thickness(2),
        };
        addBtn.Click += (_, __) =>
        {
            _inputs.Add(new InputChannel { Id = $"ch-{_inputs.Count}" });
            BuildInputs();
        };
        InputStrips.Children.Add(addBtn);
        UpdateCountLabels();
    }

    // ── Header buttons ─────────────────────────────────────────────────────

    private void OnCopy(object sender, RoutedEventArgs e)
    {
        try { Clipboard.SetText(_state.CurrentRoomId); } catch { }
        CopyBtn.Content = "已复制";
        var t = new DispatcherTimer(TimeSpan.FromMilliseconds(1600), DispatcherPriority.Normal,
            (_, __) => CopyBtn.Content = "复制", Dispatcher);
        t.Start();
        EventHandler? oneShot = null;
        oneShot = (_, __) => { t.Stop(); t.Tick -= oneShot; };
        t.Tick += oneShot;
    }

    private void OnSettings(object sender, RoutedEventArgs e)
    {
        var dlg = new SettingsSheet(_state.Audio, _state) { Owner = Window.GetWindow(this) };
        dlg.ShowDialog();
    }

    private void OnToggleMic(object sender, RoutedEventArgs e)
    {
        _state.Audio.IsMicMuted = !_state.Audio.IsMicMuted;
        UpdateMicBtn();
    }

    private void UpdateMicBtn()
    {
        if (_state.Audio.IsMicMuted)
        {
            MicBtn.Content = "MIC OFF";
            MicBtn.Background = new SolidColorBrush(Color.FromRgb(0x8C, 0x1A, 0x1A));
        }
        else
        {
            MicBtn.Content = "MIC ON";
            MicBtn.Background = new SolidColorBrush(Color.FromRgb(0x1A, 0x66, 0x33));
        }
    }

    private void OnSwitchRoom(object sender, RoutedEventArgs e)
    {
        var dlg = new SwitchRoomSheet { Owner = Window.GetWindow(this) };
        if (dlg.ShowDialog() == true) _state.SwitchToRoom(dlg.RoomId);
    }

    private void OnReturnHome(object sender, RoutedEventArgs e) => _state.ReturnToMyRoom();

    private void OnRoomIdTriple(object sender, MouseButtonEventArgs e)
    {
        var now = DateTime.UtcNow;
        if ((now - _lastClickTs).TotalMilliseconds > 600) _clickCount = 0;
        _clickCount++;
        _lastClickTs = now;
        if (_clickCount >= 3)
        {
            _clickCount = 0;
            var dlg = new AudioDebugSheet(_state.Audio) { Owner = Window.GetWindow(this) };
            dlg.ShowDialog();
        }
    }

    private void UpdateCountLabels()
    {
        int peerCount = UnionPeerIds().Count;
        MixerCountText.Text = $"{peerCount + 1} CH";
        InputCountText.Text = $"{_inputs.Count} CH";
    }

    private void OnTestTone(object sender, RoutedEventArgs e)
    {
        // Generate a 0.5s 440 Hz sine via NAudio shared mode (separate from
        // the running exclusive engine) so user can sanity-check default
        // playback device. Doesn't go through Tonel's audio pipeline.
        try
        {
            var wo = new WaveOutEvent();
            var sine = new SignalGenerator(48000, 1)
            {
                Gain = 0.3, Frequency = 440, Type = SignalGeneratorType.Sin,
            }.Take(TimeSpan.FromMilliseconds(500));
            wo.Init(sine);
            wo.Play();
            wo.PlaybackStopped += (_, __) => wo.Dispose();
        }
        catch (Exception ex) { AppLog.Log($"[RoomView] testTone err: {ex.Message}"); }
    }
}
