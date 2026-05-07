using System.ComponentModel;
using System.Windows;
using TonelWindows.App;
using TonelWindows.Views;

namespace TonelWindows;

/// <summary>
/// v6.2.0+ there's only one screen — the room. App boots into it via
/// AppState.BootstrapAsync() which auto-joins a room before the UI ever
/// renders an empty state. Connection failures surface as the modal alert.
/// </summary>
public partial class MainWindow : Window
{
    private readonly AppState _state = AppEntry.State;

    public MainWindow()
    {
        InitializeComponent();
        _state.PropertyChanged += OnStateChanged;
        RootHost.Content = new RoomView(_state);
    }

    private void OnStateChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(AppState.LastError) && !string.IsNullOrEmpty(_state.LastError))
        {
            var msg = _state.LastError +
                      "\n\n如果当前网络封锁直连 UDP，可在 设置 → 服务器与传输模式 切换到 WS 兜底重试。";
            MessageBox.Show(msg, "连接失败");
            _state.LastError = null;
        }
    }
}
