import Foundation

/// Tiny file logger — the unified-log pipeline redacts our NSLog text as
/// `<private>` since iOS 14 / macOS 11, which makes diagnostics impossible
/// from the outside. Append plain text to `/tmp/tonel-app.log` so we (and
/// the user) can `tail -f` it during dev. Still NSLog as well so the
/// timestamp shows up next to system events.
enum AppLog {
    private static let path = "/tmp/tonel-app.log"
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
