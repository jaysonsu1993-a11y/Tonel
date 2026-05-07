using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace TonelWindows.Models;

public sealed class PeerVM : INotifyPropertyChanged
{
    public string UserId { get; }

    private float _level;
    public float Level
    {
        get => _level;
        set { if (_level != value) { _level = value; OnChanged(); } }
    }

    private float _gain = 1.0f;
    public float Gain
    {
        get => _gain;
        set { if (_gain != value) { _gain = value; OnChanged(); } }
    }

    private bool _muted;
    public bool Muted
    {
        get => _muted;
        set { if (_muted != value) { _muted = value; OnChanged(); } }
    }

    public PeerVM(string userId) { UserId = userId; }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? n = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public readonly record struct PeerInfo(string UserId);
