using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace TonelWindows.Views;

/// <summary>
/// Single-bar LED meter — bit-for-bit port of web LedMeter.tsx and
/// macOS LedMeterView. dB scale: 0 dB → 100%, -60 dB → 0%.
/// Custom-drawn for performance — a Border + Rectangle would re-layout
/// each tick at 10 Hz update rate.
/// </summary>
public sealed class LedMeterView : FrameworkElement
{
    public static readonly DependencyProperty LevelProperty =
        DependencyProperty.Register(nameof(Level), typeof(float), typeof(LedMeterView),
            new FrameworkPropertyMetadata(0f, FrameworkPropertyMetadataOptions.AffectsRender));

    public float Level
    {
        get => (float)GetValue(LevelProperty);
        set => SetValue(LevelProperty, value);
    }

    private static readonly Brush GrooveBrush =
        new SolidColorBrush(Color.FromArgb(0x80, 0x29, 0x29, 0x29));
    private static readonly LinearGradientBrush FillBrush = MakeFill();

    private static LinearGradientBrush MakeFill()
    {
        var b = new LinearGradientBrush
        {
            StartPoint = new Point(0, 1),
            EndPoint = new Point(0, 0),
        };
        b.GradientStops.Add(new GradientStop(Color.FromRgb(0x22, 0xC5, 0x5E), 0.00));
        b.GradientStops.Add(new GradientStop(Color.FromRgb(0x22, 0xC5, 0x5E), 0.60));
        b.GradientStops.Add(new GradientStop(Color.FromRgb(0xEA, 0xB3, 0x08), 0.80));
        b.GradientStops.Add(new GradientStop(Color.FromRgb(0xEF, 0x44, 0x44), 1.00));
        b.Freeze();
        return b;
    }

    private static float ToDbFraction(float v)
    {
        if (v <= 0) return 0;
        var db = 20.0 * Math.Log10(v);
        var f = (db + 60.0) / 60.0;
        return (float)Math.Clamp(f, 0, 1);
    }

    static LedMeterView() { GrooveBrush.Freeze(); }

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth; var h = ActualHeight;
        if (w <= 0 || h <= 0) return;
        var pct = ToDbFraction(Level);
        var radius = 4.0;
        dc.DrawRoundedRectangle(GrooveBrush, null, new Rect(0, 0, w, h), radius, radius);
        var fillH = h * pct;
        if (fillH > 0)
        {
            var fillRect = new Rect(0, h - fillH, w, fillH);
            dc.PushClip(new RectangleGeometry(new Rect(0, 0, w, h), radius, radius));
            dc.DrawRectangle(FillBrush, null, fillRect);
            dc.Pop();
        }
    }
}
