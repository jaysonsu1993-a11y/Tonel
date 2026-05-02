import Foundation

/// Tiny file logger — the unified-log pipeline redacts our NSLog text as
/// `<private>` since iOS 14 / macOS 11, which makes diagnostics impossible
/// from the outside. Append plain text to a sandbox-accessible file so we
/// (and the user) can `tail -f` it during dev. The path is symlinked from
/// `/tmp/tonel-app.log` for back-compat with existing tail commands.
/// Still NSLog as well so the timestamp shows up next to system events.
enum AppLog {
    /// `NSTemporaryDirectory()` resolves inside the sandbox container
    /// (~/Library/Containers/<bundle-id>/Data/tmp/) — writable from a
    /// sandboxed app, unlike `/tmp/` which is inaccessible. Symlink
    /// `/tmp/tonel-app.log → real path` is created on first run so
    /// `tail -f /tmp/tonel-app.log` keeps working.
    private static let path: String = {
        let real = (NSTemporaryDirectory() as NSString)
                       .appendingPathComponent("tonel-app.log")
        // Best-effort symlink so /tmp/tonel-app.log keeps working.
        let alias = "/tmp/tonel-app.log"
        let fm = FileManager.default
        // Replace existing symlink/file if it points to a different target.
        if let existing = try? fm.destinationOfSymbolicLink(atPath: alias),
           existing == real {
            // already correct
        } else {
            try? fm.removeItem(atPath: alias)
            try? fm.createSymbolicLink(atPath: alias,
                                       withDestinationPath: real)
        }
        return real
    }()
    private static let handle: FileHandle? = {
        let url = URL(fileURLWithPath: path)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        let h = try? FileHandle(forWritingTo: url)
        try? h?.seekToEnd()
        return h
    }()
    private static let fmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func log(_ msg: String) {
        let line = "\(fmt.string(from: Date())) \(msg)\n"
        NSLog("%@", line)
        if let data = line.data(using: .utf8) { try? handle?.write(contentsOf: data) }
    }
}
