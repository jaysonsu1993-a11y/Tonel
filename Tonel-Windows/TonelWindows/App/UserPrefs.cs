using System;
using Microsoft.Win32;

namespace TonelWindows.App;

/// <summary>
/// Tiny UserDefaults equivalent — persists a flat key/value namespace
/// under HKCU\Software\Tonel. Used for server/transport selection,
/// HW buffer override, etc. (Same role as @AppStorage on macOS.)
/// </summary>
public static class UserPrefs
{
    private const string KeyPath = @"Software\Tonel";

    public static string? GetString(string key)
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(KeyPath, writable: false);
            return k?.GetValue(key) as string;
        }
        catch { return null; }
    }

    public static int GetInt(string key, int fallback = 0)
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(KeyPath, writable: false);
            var v = k?.GetValue(key);
            return v is int i ? i : (v is string s && int.TryParse(s, out var p) ? p : fallback);
        }
        catch { return fallback; }
    }

    public static void SetString(string key, string value)
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(KeyPath, writable: true);
            k?.SetValue(key, value, RegistryValueKind.String);
        }
        catch (Exception e) { AppLog.Log($"[UserPrefs] set err: {e.Message}"); }
    }

    public static void SetInt(string key, int value)
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(KeyPath, writable: true);
            k?.SetValue(key, value, RegistryValueKind.DWord);
        }
        catch (Exception e) { AppLog.Log($"[UserPrefs] set err: {e.Message}"); }
    }

    public static void Remove(string key)
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(KeyPath, writable: true);
            k?.DeleteValue(key, throwOnMissingValue: false);
        }
        catch { }
    }
}
