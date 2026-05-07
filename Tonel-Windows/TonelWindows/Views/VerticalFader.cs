using System;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace TonelWindows.Views;

/// <summary>
/// Vertical fader, custom-drawn — value 0…100 increasing upward.
/// Drag to set; scroll wheel = ±1 dB step (Shift = ±0.1 dB fine).
/// Mirrors macOS FaderView (NSView).
/// </summary>
public sealed class VerticalFader : FrameworkElement
{
    public static readonly DependencyProperty ValueProperty =
        DependencyProperty.Register(nameof(Value), typeof(double), typeof(VerticalFader),
            new FrameworkPropertyMetadata(100.0,
                FrameworkPropertyMetadataOptions.AffectsRender | FrameworkPropertyMetadataOptions.BindsTwoWayByDefault,
                (d, _) => ((VerticalFader)d).InvalidateVisual()));

    public double Value
    {
        get => (double)GetValue(ValueProperty);
        set => SetValue(ValueProperty, value);
    }

    public event Action<double>? ValueChangedByUser;

    private const double TrackInset = 4;
    private const double CapHeight = 22;
    private const double CapWidth = 24;

    public VerticalFader()
    {
        Focusable = true;
        Cursor = Cursors.Hand;
    }

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth; var h = ActualHeight;
        if (w <= 0 || h <= 0) return;

        // Track
        var trackRect = new Rect(w / 2 - 2, TrackInset, 4, h - 2 * TrackInset);
        dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(31, 31, 31)), null, trackRect, 2, 2);

        // Tick marks every 10
        var tickPen = new Pen(new SolidColorBrush(Color.FromRgb(77, 77, 77)), 1);
        tickPen.Freeze();
        for (int t = 0; t <= 100; t += 10)
        {
            double y = RatioToY(t / 100.0, h);
            dc.DrawLine(tickPen, new Point(w / 2 - 8, y), new Point(w / 2 + 8, y));
        }

        // Cap
        double capY = RatioToY(Value / 100.0, h);
        var cap = new Rect((w - CapWidth) / 2, capY - CapHeight / 2, CapWidth, CapHeight);
        var capFill = new SolidColorBrush(Color.FromRgb(46, 51, 61));
        var capPen = new Pen(new SolidColorBrush(Color.FromRgb(115, 115, 115)), 1);
        dc.DrawRoundedRectangle(capFill, capPen, cap, 3, 3);
        var midPen = new Pen(new SolidColorBrush(Color.FromRgb(178, 178, 178)), 1);
        dc.DrawLine(midPen, new Point(cap.Left + 4, cap.Top + cap.Height / 2),
                            new Point(cap.Right - 4, cap.Top + cap.Height / 2));
    }

    private static double RatioToY(double r, double h)
    {
        var usable = h - 2 * TrackInset - CapHeight;
        // r=0 → bottom, r=1 → top.
        return TrackInset + CapHeight / 2 + (1 - r) * usable;
    }

    private static double YToRatio(double y, double h)
    {
        var usable = h - 2 * TrackInset - CapHeight;
        var raw = (h - TrackInset - CapHeight / 2 - y) / Math.Max(1, usable);
        if (raw < 0) raw = 0; else if (raw > 1) raw = 1;
        return raw;
    }

    protected override void OnMouseDown(MouseButtonEventArgs e)
    {
        Focus();
        CaptureMouse();
        Commit(e.GetPosition(this).Y);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (e.LeftButton == MouseButtonState.Pressed && IsMouseCaptured)
            Commit(e.GetPosition(this).Y);
    }

    protected override void OnMouseUp(MouseButtonEventArgs e) => ReleaseMouseCapture();

    protected override void OnMouseWheel(MouseWheelEventArgs e)
    {
        bool fine = (Keyboard.Modifiers & ModifierKeys.Shift) != 0;
        double step = fine ? 0.1 : 1.0;
        double dir = e.Delta > 0 ? 1 : -1;
        double currentDb = Value <= 0 ? -60 : 20.0 * Math.Log10(Value / 100.0);
        double newDb = Math.Min(0, Math.Max(-60, currentDb + dir * step));
        double newVol = newDb <= -60 ? 0 : Math.Min(100, Math.Pow(10, newDb / 20) * 100);
        Value = newVol;
        ValueChangedByUser?.Invoke(newVol);
        e.Handled = true;
    }

    private void Commit(double y)
    {
        var r = YToRatio(y, ActualHeight);
        var v = r * 100.0;
        Value = v;
        ValueChangedByUser?.Invoke(v);
    }
}
