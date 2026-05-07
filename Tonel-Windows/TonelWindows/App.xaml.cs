using System;
using System.Windows;
using System.Windows.Threading;

namespace TonelWindows.App;

public partial class AppEntry : Application
{
    public static AppState State { get; } = new();

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += OnUnhandled;
        AppDomain.CurrentDomain.UnhandledException += (_, ev) =>
            AppLog.Log($"[App] domain unhandled: {ev.ExceptionObject}");
        AppLog.Log("[App] startup");
    }

    private void OnUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        AppLog.Log($"[App] dispatcher unhandled: {e.Exception}");
        MessageBox.Show(e.Exception.Message, "Tonel — 错误");
        e.Handled = true;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        AppLog.Log("[App] exit");
        try { State.Audio.Stop(); State.Mixer.Disconnect(); State.Signal.Disconnect(); } catch { }
        base.OnExit(e);
    }
}
