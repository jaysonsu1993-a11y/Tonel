using System;
using System.Windows;
using System.Windows.Threading;
using TonelWindows.Audio;

namespace TonelWindows.Views;

public partial class AudioDebugSheet : Window
{
    private readonly AudioEngine _audio;
    private readonly DispatcherTimer _timer;
    private bool _suppress;

    public AudioDebugSheet(AudioEngine audio)
    {
        InitializeComponent();
        _audio = audio;
        _suppress = true;
        PrimeMin.Value     = audio.ClientPrimeMin;
        JitterTarget.Value = audio.ServerJitterTarget;
        JitterMax.Value    = audio.ServerJitterMaxDepth;
        UpdateLabels();
        _suppress = false;
        _timer = new DispatcherTimer(TimeSpan.FromMilliseconds(200), DispatcherPriority.Normal, (_, __) => Refresh(), Dispatcher);
        _timer.Start();
        Closed += (_, __) => _timer.Stop();
    }

    private void OnPrimeMin(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_suppress) return;
        _audio.ClientPrimeMin = (int)e.NewValue;
        UpdateLabels();
    }
    private void OnJitterTarget(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_suppress) return;
        _audio.ServerJitterTarget = (int)e.NewValue;
        UpdateLabels();
    }
    private void OnJitterMax(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_suppress) return;
        _audio.ServerJitterMaxDepth = (int)e.NewValue;
        UpdateLabels();
    }

    private void UpdateLabels()
    {
        PrimeMinText.Text     = $"{_audio.ClientPrimeMin} fr · {_audio.ClientPrimeMin * AudioWire.FrameMs:F1} ms";
        JitterTargetText.Text = $"{_audio.ServerJitterTarget} fr · {_audio.ServerJitterTarget * AudioWire.FrameMs:F1} ms";
        JitterMaxText.Text    = $"{_audio.ServerJitterMaxDepth} fr · {_audio.ServerJitterMaxDepth * AudioWire.FrameMs:F1} ms cap";
    }

    private void Refresh()
    {
        var lines = new[]
        {
            $"running   {_audio.IsRunning}",
            $"input lvl {_audio.InputLevel:F3}",
            $"tx        {_audio.TxCount}",
            $"rx        {_audio.RxCount}",
            $"seq gap   {_audio.SeqGapCount}",
            $"ring drop {_audio.RingDropCount}",
            $"clip      {_audio.CaptureClipCount}",
            $"sr        {(int)_audio.ActualSampleRate}",
            $"peers     {_audio.PeerLevels.Count}",
        };
        LiveText.Text = string.Join("\n", lines);
    }

    private void OnClose(object sender, RoutedEventArgs e) => Close();
}
