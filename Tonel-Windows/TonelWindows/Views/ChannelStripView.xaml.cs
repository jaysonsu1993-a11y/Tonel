using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace TonelWindows.Views;

/// <summary>
/// Channel strip — visual parity with web ChannelStrip.tsx and macOS
/// ChannelStripView. Volume model: 0–100 (canonical web), converts to
/// linear gain on send (v/100).
/// </summary>
public partial class ChannelStripView : UserControl
{
    public ChannelStripView()
    {
        InitializeComponent();
        Fader.ValueChangedByUser += v =>
        {
            _volume = v;
            UpdateDbReadout();
            UpdateMeterDisplay();
            VolumeChanged?.Invoke(v);
        };
    }

    public string Title { set => TitleText.Text = value; }
    public string? Subtitle
    {
        set
        {
            SubtitleText.Text = value ?? "";
            SubtitleText.Visibility = string.IsNullOrEmpty(value) ? Visibility.Collapsed : Visibility.Visible;
        }
    }
    public bool IsSelf
    {
        set
        {
            TitleText.Foreground = value ? (Brush)FindResource("AccentGreen") : (Brush)FindResource("TextPrimary");
            StripBorder.BorderBrush = value
                ? new SolidColorBrush(Color.FromArgb(0x80, 0x22, 0xC5, 0x5E))
                : new SolidColorBrush(Color.FromArgb(0x0F, 0xFF, 0xFF, 0xFF));
        }
    }

    public bool ShowSolo { set => SoloBtn.Visibility = value ? Visibility.Visible : Visibility.Collapsed; }
    public bool ShowMute { set => MuteBtn.Visibility = value ? Visibility.Visible : Visibility.Collapsed; }

    private float _level;
    public float Level
    {
        get => _level;
        set { _level = value; UpdateMeterDisplay(); }
    }

    private double _volume = 100;
    public double Volume
    {
        get => _volume;
        set { _volume = value; Fader.Value = value; UpdateDbReadout(); UpdateMeterDisplay(); }
    }

    private bool _muted;
    public bool Muted
    {
        get => _muted;
        set { _muted = value; ApplyButtonState(MuteBtn, value, Color.FromRgb(0xC0, 0x29, 0x29)); UpdateMeterDisplay(); }
    }

    private bool _soloed;
    public bool Soloed
    {
        get => _soloed;
        set { _soloed = value; ApplyButtonState(SoloBtn, value, Color.FromRgb(0xEA, 0xB3, 0x08)); }
    }

    public event Action<double>? VolumeChanged;
    public event Action<bool>? MuteChanged;
    public event Action<bool>? SoloChanged;

    private void OnMuteClick(object sender, RoutedEventArgs e)
    {
        Muted = !Muted;
        MuteChanged?.Invoke(Muted);
    }

    private void OnSoloClick(object sender, RoutedEventArgs e)
    {
        Soloed = !Soloed;
        SoloChanged?.Invoke(Soloed);
    }

    private void ApplyButtonState(Button btn, bool active, Color activeColor)
    {
        if (active)
        {
            btn.Background = new SolidColorBrush(activeColor);
            btn.Foreground = Brushes.White;
        }
        else
        {
            btn.Background = new SolidColorBrush(Color.FromRgb(0x2E, 0x2E, 0x2E));
            btn.Foreground = new SolidColorBrush(Color.FromRgb(0xB2, 0xB2, 0xB2));
        }
    }

    private void UpdateDbReadout()
    {
        if (_volume <= 0) DbText.Text = "-inf dB";
        else DbText.Text = $"{(int)Math.Round(20.0 * Math.Log10(_volume / 100.0))} dB";
    }

    private void UpdateMeterDisplay()
    {
        Meter.Level = _muted ? 0 : _level * (float)(_volume / 100.0);
    }
}
