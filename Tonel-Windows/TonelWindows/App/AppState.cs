using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows;
using TonelWindows.Audio;
using TonelWindows.Models;
using TonelWindows.Network;

namespace TonelWindows.App;

/// <summary>
/// Top-level glue object — owns long-lived clients and the active room
/// session.
///
/// v6.2.0 dropped the login + home-page flow. The app now boots directly
/// into a room: <see cref="Identity.LoadOrCreate"/> lazily generates a
/// persistent userId + myRoomId on first launch, and Bootstrap() auto-
/// joins the user's last-used room (defaults to their own personal room)
/// before the UI ever appears. There's no logout — identity only resets
/// via the Settings 重置身份 button.
///
/// v6.4.0+ always uses JOIN_ROOM; the server auto-creates if missing.
/// </summary>
public sealed class AppState : INotifyPropertyChanged
{
    // ── Identity ────────────────────────────────────────────────────────────

    /// <summary>Persistent user id — generated once on first launch.</summary>
    public string UserId { get; private set; }
    /// <summary>The user's personal room (their "home base"). Stable for
    /// the lifetime of the identity. Doesn't change when user switches rooms.</summary>
    public string MyRoomId { get; private set; }
    /// <summary>The room the user is currently in. Sticky across launches.</summary>
    public string CurrentRoomId
    {
        get => _currentRoomId;
        private set { if (_currentRoomId != value) { _currentRoomId = value; OnChanged(); } }
    }
    private string _currentRoomId = "";

    // ── Room session state ────────────────────────────────────────────────

    public ObservableCollection<PeerVM> Peers { get; } = new();

    private string _statusText = "";
    public string StatusText { get => _statusText; set { if (_statusText != value) { _statusText = value; OnChanged(); } } }

    private bool _isJoining;
    public bool IsJoining { get => _isJoining; set { if (_isJoining != value) { _isJoining = value; OnChanged(); } } }

    private string? _lastError;
    public string? LastError { get => _lastError; set { if (_lastError != value) { _lastError = value; OnChanged(); } } }

    private bool _hasBootstrapped;
    public bool HasBootstrapped { get => _hasBootstrapped; private set { if (_hasBootstrapped != value) { _hasBootstrapped = value; OnChanged(); } } }

    public bool IsConnected => !string.IsNullOrEmpty(CurrentRoomId) && !IsJoining;

    // ── Long-lived clients ────────────────────────────────────────────────

    public SignalClient Signal { get; } = new();
    public AudioEngine  Audio  { get; } = new();

    /// <summary>Active mixer transport. Reassigned on transport-mode change.</summary>
    public IMixerTransport Mixer
    {
        get => _mixer;
        private set { if (!ReferenceEquals(_mixer, value)) { _mixer = value; OnChanged(); } }
    }
    private IMixerTransport _mixer;

    private ServerLocation _serverLocation;
    public ServerLocation ServerLocation
    {
        get => _serverLocation;
        private set { if (_serverLocation != value) { _serverLocation = value; OnChanged(); } }
    }

    private TransportMode _transportMode;
    public TransportMode TransportMode
    {
        get => _transportMode;
        private set { if (_transportMode != value) { _transportMode = value; OnChanged(); } }
    }

    // ── Init ──────────────────────────────────────────────────────────────

    public AppState()
    {
        // Identity first
        var id = Identity.LoadOrCreate();
        UserId   = id.UserId;
        MyRoomId = id.MyRoomId;
        // currentRoomId is populated after successful join

        // Server / transport selection
        var savedServerId  = UserPrefs.GetString(Endpoints.ServerIdKey) ?? Endpoints.DefaultServer.Id;
        var savedTransport = TransportModeExtensions.ParseWire(UserPrefs.GetString(Endpoints.TransportModeKey))
                           ?? Endpoints.DefaultTransport;
        var initialLoc = Endpoints.ServerById(savedServerId);
        // Defensive: a saved id pointing at a now-disabled location collapses back.
        var resolvedLoc = initialLoc.IsAvailable ? initialLoc : Endpoints.DefaultServer;
        _serverLocation = resolvedLoc;
        _transportMode  = savedTransport;
        _mixer          = MakeMixer(resolvedLoc, savedTransport);

        Audio.Attach(_mixer);
        Signal.Message += HandleSignal;

        // Kick off the initial join (decoupled so window construction
        // doesn't wait on network).
        _ = BootstrapAsync();
    }

    private IMixerTransport MakeMixer(ServerLocation loc, TransportMode transport) => transport switch
    {
        TransportMode.Udp => new MixerClient(loc),
        TransportMode.Ws  => new WSMixerClient(loc),
        TransportMode.P2p => new P2PMixerClient(Signal, loc),
        _                 => new MixerClient(loc),
    };

    // ── Bootstrap ─────────────────────────────────────────────────────────

    private async Task BootstrapAsync()
    {
        var target = Identity.LoadOrCreate().CurrentRoomId;
        AppLog.Log($"[AppState] bootstrap → room={target} user={UserId} transport={TransportMode.ToWireString()}");
        await EnterRoomAsync(target);
        HasBootstrapped = true;
    }

    // ── Settings — server / transport selection ───────────────────────────

    /// <summary>Apply a Settings change. Tears down current connection,
    /// swaps mixer, re-enters same room. Returns true if a swap happened.</summary>
    public bool ApplyTransportSelection(ServerLocation server, TransportMode transport)
    {
        UserPrefs.SetString(Endpoints.ServerIdKey,      server.Id);
        UserPrefs.SetString(Endpoints.TransportModeKey, transport.ToWireString());

        bool same = server.Id == ServerLocation.Id && transport == TransportMode;
        if (same) return false;

        var roomToReenter = string.IsNullOrEmpty(CurrentRoomId) ? MyRoomId : CurrentRoomId;
        _ = Task.Run(async () =>
        {
            await TearDownSessionAsync();
            await Application.Current.Dispatcher.InvokeAsync(() =>
            {
                ServerLocation = server;
                TransportMode  = transport;
                Mixer          = MakeMixer(server, transport);
                Audio.Attach(Mixer);
                AppLog.Log($"[AppState] transport swapped → server={server.Id} transport={transport.ToWireString()}, re-entering room={roomToReenter}");
            });
            await EnterRoomAsync(roomToReenter);
        });
        return true;
    }

    // ── Room switching ────────────────────────────────────────────────────

    public void SwitchToRoom(string roomId)
    {
        var trimmed = (roomId ?? "").Trim().ToUpperInvariant();
        if (!Identity.IsPlausibleRoomId(trimmed))
        {
            LastError = "房间号格式不对（3–32 位字母 / 数字）";
            return;
        }
        _ = Task.Run(async () =>
        {
            await TearDownSessionAsync();
            await EnterRoomAsync(trimmed);
        });
    }

    public void ReturnToMyRoom()
    {
        if (CurrentRoomId == MyRoomId) return;
        _ = Task.Run(async () =>
        {
            await TearDownSessionAsync();
            await EnterRoomAsync(MyRoomId);
        });
    }

    public void ResetIdentity()
    {
        Identity.Reset();
        var fresh = Identity.LoadOrCreate();
        Application.Current.Dispatcher.Invoke(() =>
        {
            UserId   = fresh.UserId;
            MyRoomId = fresh.MyRoomId;
            OnChanged(nameof(UserId));
            OnChanged(nameof(MyRoomId));
        });
        _ = Task.Run(async () =>
        {
            await TearDownSessionAsync();
            await EnterRoomAsync(fresh.MyRoomId);
        });
    }

    // ── Connection lifecycle ──────────────────────────────────────────────

    /// <summary>v6.4.0+ always JOIN_ROOM — server auto-creates if missing.</summary>
    private async Task EnterRoomAsync(string roomId)
    {
        AppLog.Log($"[AppState] enterRoom roomId={roomId} userId={UserId}");
        await Application.Current.Dispatcher.InvokeAsync(() =>
        {
            IsJoining  = true;
            StatusText = "正在加入房间…";
            LastError  = null;
        });
        try
        {
            await Signal.ConnectAsync();
            await Signal.JoinRoomAsync(roomId, UserId, password: null);
            await Mixer.ConnectAsync(roomId, UserId);
            Audio.SyncServerTuningFromMixer();
            await Application.Current.Dispatcher.InvokeAsync(() =>
            {
                Audio.Start();
                CurrentRoomId = roomId;
                Identity.SaveCurrentRoom(roomId);
                StatusText = "已连接";
            });
            AppLog.Log($"[AppState] enterRoom DONE — roomId={roomId}");
        }
        catch (Exception e)
        {
            AppLog.Log($"[AppState] enterRoom ERROR: {e}");
            await Application.Current.Dispatcher.InvokeAsync(() =>
            {
                LastError = e.Message;
                Mixer.Disconnect();
                Audio.Stop();
                StatusText = "";
            });
        }
        finally
        {
            await Application.Current.Dispatcher.InvokeAsync(() => IsJoining = false);
        }
    }

    private async Task TearDownSessionAsync()
    {
        await Application.Current.Dispatcher.InvokeAsync(() =>
        {
            Audio.Stop();
            Mixer.Disconnect();
            Signal.LeaveRoom();
            Signal.Disconnect();
            CurrentRoomId = "";
            Peers.Clear();
            StatusText = "";
        });
        // Tiny delay so the server gets LEAVE before next JOIN tries to claim
        // the same slot under the same uid.
        await Task.Delay(200);
    }

    // ── Signal handling ───────────────────────────────────────────────────

    private void HandleSignal(SignalMessage msg)
    {
        var disp = Application.Current?.Dispatcher;
        if (disp != null && !disp.CheckAccess()) { disp.BeginInvoke((Action)(() => HandleSignal(msg))); return; }

        switch (msg)
        {
            case SignalMessage.PeerListMsg pl:
                Peers.Clear();
                foreach (var p in pl.Peers.Where(p => p.UserId != UserId))
                    Peers.Add(new PeerVM(p.UserId));
                break;
            case SignalMessage.PeerJoinedMsg pj when pj.Peer.UserId != UserId:
                if (!Peers.Any(p => p.UserId == pj.Peer.UserId))
                    Peers.Add(new PeerVM(pj.Peer.UserId));
                break;
            case SignalMessage.PeerLeftMsg pl:
                for (int i = Peers.Count - 1; i >= 0; i--)
                    if (Peers[i].UserId == pl.UserId) Peers.RemoveAt(i);
                break;
            case SignalMessage.SessionReplacedMsg:
                LastError = "你的账号在其它设备登录了";
                _ = TearDownSessionAsync();
                break;
            case SignalMessage.ErrorMsg em:
                LastError = em.Message;
                break;
        }
    }

    public void RefreshLevels()
    {
        var levels = Audio.PeerLevels;
        foreach (var p in Peers)
            p.Level = levels.TryGetValue(p.UserId, out var v) ? v : 0;
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? n = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}
