using System;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace TonelWindows.App;

/// <summary>
/// Persistent identity for an unregistered Tonel user. Mirrors
/// macOS Identity.swift.
///
/// v6.2.0 dropped the login + home-page flow. The app now boots directly
/// into a room. To make that work without an account system, every user
/// gets a locally-generated userId on first launch (saved as JSON in
/// %LOCALAPPDATA%\Tonel\identity.json — equivalent to UserDefaults on
/// macOS) plus a personal myRoomId — a 6-character uppercase alphanumeric
/// room number short enough to share verbally with bandmates.
///
/// Identity persists across launches; the only way to reset it is the
/// "重置身份" button in Settings.
/// </summary>
public static class Identity
{
    public sealed record Snapshot(string UserId, string MyRoomId, string CurrentRoomId);

    private static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tonel");
    private static readonly string DataPath = Path.Combine(DataDir, "identity.json");

    private sealed class Storage
    {
        public string? UserId { get; set; }
        public string? MyRoomId { get; set; }
        public string? CurrentRoomId { get; set; }
    }

    /// <summary>Load (and lazily create) the persistent identity.</summary>
    public static Snapshot LoadOrCreate()
    {
        var s = ReadOrEmpty();
        bool dirty = false;
        if (string.IsNullOrEmpty(s.UserId))   { s.UserId   = GenerateUserId(); dirty = true; }
        if (string.IsNullOrEmpty(s.MyRoomId)) { s.MyRoomId = GenerateRoomId(); dirty = true; }
        if (string.IsNullOrEmpty(s.CurrentRoomId)) { s.CurrentRoomId = s.MyRoomId; dirty = true; }
        if (dirty) Save(s);
        return new Snapshot(s.UserId!, s.MyRoomId!, s.CurrentRoomId!);
    }

    /// <summary>Update the sticky current-room pointer.</summary>
    public static void SaveCurrentRoom(string roomId)
    {
        var s = ReadOrEmpty();
        s.CurrentRoomId = roomId;
        Save(s);
    }

    /// <summary>Wipe the saved identity. Caller forces a reconnect afterwards.</summary>
    public static void Reset()
    {
        try { if (File.Exists(DataPath)) File.Delete(DataPath); } catch { }
    }

    /// <summary>`user_&lt;ms&gt;_&lt;5digit&gt;` — same shape as macOS / pre-v6.2.0 ephemeral uids.</summary>
    private static string GenerateUserId()
    {
        var ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var suffix = Random.Shared.Next(0, 99999).ToString("D5");
        return $"user_{ms}_{suffix}";
    }

    /// <summary>
    /// 6-character uppercase room id. Excludes 0/1/I/O for verbal-share
    /// disambiguation. 32^6 ≈ 1.07B → collisions astronomically rare for
    /// hobby use without a server-side uniqueness check.
    /// </summary>
    private const string RoomIdAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

    public static string GenerateRoomId()
    {
        var chars = new char[6];
        for (int i = 0; i < 6; i++) chars[i] = RoomIdAlphabet[Random.Shared.Next(RoomIdAlphabet.Length)];
        return new string(chars);
    }

    /// <summary>
    /// Validate a user-typed room id when switching rooms. Strict alphabet
    /// not enforced (older / web-created rooms may use other chars).
    /// </summary>
    public static bool IsPlausibleRoomId(string s)
    {
        var t = (s ?? "").Trim();
        if (t.Length < 3 || t.Length > 32) return false;
        return t.All(c => c < 128 && (char.IsLetterOrDigit(c) || c == '_' || c == '-'));
    }

    private static Storage ReadOrEmpty()
    {
        try
        {
            if (File.Exists(DataPath))
            {
                var json = File.ReadAllText(DataPath);
                return JsonSerializer.Deserialize<Storage>(json) ?? new Storage();
            }
        }
        catch (Exception e) { AppLog.Log($"[Identity] read err: {e.Message}"); }
        return new Storage();
    }

    private static void Save(Storage s)
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(DataPath, JsonSerializer.Serialize(s,
                new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception e) { AppLog.Log($"[Identity] save err: {e.Message}"); }
    }
}
