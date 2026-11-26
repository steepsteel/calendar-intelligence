import Foundation
import SwiftUI

private struct Probe: Decodable {
    let id: String
    let receivedAt: String
}

@main
struct CalendarIntelProbe: App {
    var body: some Scene {
        WindowGroup {
            ProbeView()
        }
    }
}

private struct ProbeView: View {
    @State private var probe: Probe?
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("CalendarIntel").font(.headline)
                if let probe {
                    Text("Connected").font(.headline)
                    Text(probe.receivedAt).font(.caption2)
                    Text("Request " + probe.id.prefix(8)).font(.caption2)
                }
                if failed {
                    Text("Could not reach the test server.").font(.caption)
                }
                Button(loading ? "Checking…" : "Check connection") {
                    Task { await check() }
                }
                .disabled(loading)
            }
        }
    }

    private func check() async {
        loading = true
        failed = false
        probe = nil
        defer { loading = false }

        guard let address = Bundle.main.object(forInfoDictionaryKey: "CalendarIntelProbeURL") as? String,
              let url = URL(string: address), url.scheme == "https", url.host != nil else {
            failed = true
            return
        }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                failed = true
                return
            }
            probe = try JSONDecoder().decode(Probe.self, from: data)
        } catch {
            failed = true
        }
    }
}
