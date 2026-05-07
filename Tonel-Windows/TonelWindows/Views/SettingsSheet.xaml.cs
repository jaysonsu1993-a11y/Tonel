using System.Windows;
using System.Windows.Controls;
using TonelWindows.App;
using TonelWindows.Audio;
using TonelWindows.Network;

namespace TonelWindows.Views;

public partial class SettingsSheet : Window
{
    private readonly AudioEngine _audio;
    private readonly AppState? _state;
    private bool _suppress = true;

    public SettingsSheet(AudioEngine audio) : this(audio, null) { }

    public SettingsSheet(AudioEngine audio, AppState? state)
    {
        InitializeComponent();
        _audio = audio;
        _state = state;
        Loaded += (_, __) => Populate();
    }

    private void Populate()
    {
        // Server picker
        ServerCombo.Items.Clear();
        foreach (var s in Endpoints.AllServers)
        {
            ServerCombo.Items.Add(new ComboBoxItem
            {
                Content = s.IsAvailable ? s.DisplayName : $"{s.DisplayName}（暂不可用）",
                Tag = s.Id,
                IsEnabled = s.IsAvailable,
            });
        }
        var curServerId = _state?.ServerLocation.Id ?? Endpoints.DefaultServer.Id;
        for (int i = 0; i < ServerCombo.Items.Count; i++)
            if (((ComboBoxItem)ServerCombo.Items[i]).Tag is string id && id == curServerId)
                ServerCombo.SelectedIndex = i;
        if (ServerCombo.SelectedIndex < 0) ServerCombo.SelectedIndex = 0;

        // Transport picker
        TransportCombo.Items.Clear();
        foreach (TransportMode m in System.Enum.GetValues<TransportMode>())
        {
            TransportCombo.Items.Add(new ComboBoxItem
            {
                Content = m.ToDisplayName(),
                Tag = m,
            });
        }
        var curTransport = _state?.TransportMode ?? Endpoints.DefaultTransport;
        for (int i = 0; i < TransportCombo.Items.Count; i++)
            if (((ComboBoxItem)TransportCombo.Items[i]).Tag is TransportMode m && m == curTransport)
                TransportCombo.SelectedIndex = i;

        // Audio devices
        var ins = AudioEngine.ListInputDevices();
        InputCombo.Items.Clear();
        foreach (var d in ins) InputCombo.Items.Add(new ComboBoxItem { Content = d.Name, Tag = d.Id });
        var curIn = _audio.CurrentInputDeviceId;
        if (curIn != null)
            for (int i = 0; i < InputCombo.Items.Count; i++)
                if (((ComboBoxItem)InputCombo.Items[i]).Tag is string id && id == curIn)
                    InputCombo.SelectedIndex = i;
        if (InputCombo.SelectedIndex < 0 && InputCombo.Items.Count > 0) InputCombo.SelectedIndex = 0;

        var outs = AudioEngine.ListOutputDevices();
        OutputCombo.Items.Clear();
        foreach (var d in outs) OutputCombo.Items.Add(new ComboBoxItem { Content = d.Name, Tag = d.Id });
        var curOut = _audio.CurrentOutputDeviceId;
        if (curOut != null)
            for (int i = 0; i < OutputCombo.Items.Count; i++)
                if (((ComboBoxItem)OutputCombo.Items[i]).Tag is string id && id == curOut)
                    OutputCombo.SelectedIndex = i;
        if (OutputCombo.SelectedIndex < 0 && OutputCombo.Items.Count > 0) OutputCombo.SelectedIndex = 0;

        ActualText.Text = $"实际采样率：{(int)_audio.ActualSampleRate} Hz · 采集 {_audio.CaptureHwFrames} fr · 输出 {_audio.OutputHwFrames} fr";

        if (_state != null)
        {
            UserIdText.Text = $"userId   = {_state.UserId}";
            MyRoomText.Text = $"myRoomId = {_state.MyRoomId}";
        }
        _suppress = false;
    }

    private void OnServerOrTransportChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppress || _state == null) return;
        if (ServerCombo.SelectedItem is not ComboBoxItem sCi || sCi.Tag is not string sid) return;
        if (TransportCombo.SelectedItem is not ComboBoxItem tCi || tCi.Tag is not TransportMode tm) return;
        var server = Endpoints.ServerById(sid);
        if (!server.IsAvailable) { ErrorText.Text = $"{server.DisplayName} 暂不可用"; return; }
        ErrorText.Text = "";
        _state.ApplyTransportSelection(server, tm);
    }

    private void OnInputChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppress) return;
        if (InputCombo.SelectedItem is ComboBoxItem cbi && cbi.Tag is string id)
        {
            try { _audio.SetInputDevice(id); ErrorText.Text = ""; }
            catch (System.Exception ex) { ErrorText.Text = "切换输入失败：" + ex.Message; }
        }
    }

    private void OnOutputChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppress) return;
        if (OutputCombo.SelectedItem is ComboBoxItem cbi && cbi.Tag is string id)
        {
            try { _audio.SetOutputDevice(id); ErrorText.Text = ""; }
            catch (System.Exception ex) { ErrorText.Text = "切换输出失败：" + ex.Message; }
        }
    }

    private void OnResetIdentity(object sender, RoutedEventArgs e)
    {
        if (_state == null) return;
        var r = MessageBox.Show("确认重置身份？这会生成新的 userId / 房间号，无法找回。",
            "重置身份", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
        if (r != MessageBoxResult.OK) return;
        _state.ResetIdentity();
        UserIdText.Text = $"userId   = {_state.UserId}";
        MyRoomText.Text = $"myRoomId = {_state.MyRoomId}";
    }

    private void OnOk(object sender, RoutedEventArgs e) => Close();
}
