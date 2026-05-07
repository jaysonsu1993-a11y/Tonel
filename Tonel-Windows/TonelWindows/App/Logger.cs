using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace TonelWindows.App;

/// <summary>
/// Tiny file logger — appends to %TEMP%\tonel-app.log so we can `tail -F` /
/// open it during dev. Mirrors macOS AppLog. Also writes to OutputDebugString
/// so DebugView / VS Output sees it.
/// </summary>
public static class AppLog
{
    private static readonly string Path =
        System.IO.Path.Combine(System.IO.Path.GetTempPath(), "tonel-app.log");
    private static readonly object Gate = new();
    private static readonly StreamWriter? Writer = OpenWriter();

    private static StreamWriter? OpenWriter()
    {
        try
        {
            var fs = new FileStream(Path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            return new StreamWriter(fs, Encoding.UTF8) { AutoFlush = true };
        }
        catch { return null; }
    }

    public static void Log(string msg)
    {
        var line = $"{DateTime.Now:HH:mm:ss.fff} {msg}";
        Debug.WriteLine(line);
        try
        {
            lock (Gate) { Writer?.WriteLine(line); }
        }
        catch { }
    }
}
