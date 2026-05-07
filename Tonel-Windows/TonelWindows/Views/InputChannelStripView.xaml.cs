using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using TonelWindows.Audio;

namespace TonelWindows.Views;

/// <summary>
/// One mic input track — device dropdown + remove button + channel strip.
/// Mirrors macOS InputChannelStripView. The dropdown switches the
/// audio device the engine captures from (single-channel multi-input
/// is a future job; UI is set up to grow into it).
/// </summary>
public partial class InputChannelStripView : UserControl
{
    private List<AudioDeviceInfo> _devices = new();

    public InputChannelStripView()
    {
        InitializeComponent();
        Strip.IsSelf = true;
        Strip.ShowSolo = false;
        Strip.VolumeChanged += v => VolumeChanged?.Invoke(v);
        Strip.MuteChanged += m => MuteChanged?.Invoke(m);
    }

    public string ChannelLabel { set => Strip.Title = value; }

    public IList<AudioDeviceInfo> InputDevices
    {
        set
        {
            _devices = new List<AudioDeviceInfo>(value);
            DeviceMenu.Items.Clear();
            DeviceMenu.Items.Add(new ComboBoxItem { Content = "默认", Tag = "" });
            foreach (var d in _devices)
                DeviceMenu.Items.Add(new ComboBoxItem { Content = d.Name, Tag = d.Id });
            if (DeviceMenu.SelectedIndex < 0) DeviceMenu.SelectedIndex = 0;
        }
    }

    private string _selectedDeviceId = "";
    public string SelectedDeviceId
    {
        get => _selectedDeviceId;
        set
        {
            _selectedDeviceId = value;
            for (int i = 0; i < DeviceMenu.Items.Count; i++)
            {
                if (DeviceMenu.Items[i] is ComboBoxItem cbi && (string)(cbi.Tag ?? "") == value)
                {
                    DeviceMenu.SelectedIndex = i;
                    return;
                }
            }
            DeviceMenu.SelectedIndex = 0;
            Strip.Subtitle = DeviceLabel(value);
        }
    }

    public bool CanRemove
    {
        set => RemoveBtn.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
    }

    public float Level { set => Strip.Level = value; }

    public double Volume
    {
        get => Strip.Volume;
        set => Strip.Volume = value;
    }

    public bool Muted
    {
        get => Strip.Muted;
        set => Strip.Muted = value;
    }

    public event Action<string>? DeviceChanged;
    public event Action? Removed;
    public event Action<double>? VolumeChanged;
    public event Action<bool>? MuteChanged;

    private string DeviceLabel(string id)
        => string.IsNullOrEmpty(id) ? "默认" : (_devices.Find(d => d.Id == id)?.Name ?? "默认");

    private void OnDeviceChanged(object sender, SelectionChangedEventArgs e)
    {
        if (DeviceMenu.SelectedItem is ComboBoxItem cbi)
        {
            var id = (string)(cbi.Tag ?? "");
            if (id == _selectedDeviceId) return;
            _selectedDeviceId = id;
            Strip.Subtitle = DeviceLabel(id);
            DeviceChanged?.Invoke(id);
        }
    }

    private void OnRemoveClick(object sender, RoutedEventArgs e) => Removed?.Invoke();
}
