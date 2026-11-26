# Independent Apple Watch connectivity probe

Use Xcode with the watchOS SDK to create a watchOS App using the Watch-only App option. Replace the generated Swift app and view with [CalendarIntelProbe.swift](CalendarIntelProbe.swift). Add the string `CalendarIntelProbeURL` as a custom target Info property and set it to `https://calendarintel.app/api/watch/probe`. Set `WATCH_PROBE_ENABLED` to `true` on the test Worker. The endpoint supplies a fresh response ID and server time.

Run the app on the Apple Watch while the paired iPhone is on. Record the response ID, power off the iPhone and repeat the check on Wi-Fi. Repeat on cellular if the watch has an active cellular plan. A fresh ID after shutdown verifies a direct network request. A simulated or macOS run cannot verify physical radio behavior.

The probe does not request device pairing or store any credentials. A passing probe verifies network reachability. Private agenda access still requires watch authentication and a device test.
