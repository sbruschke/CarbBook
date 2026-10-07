import CarbBookCore
import CarbBookKit
import QuickLook
import SwiftUI
import UIKit

/// Log export spec 2026-10-07: pick a range, get a PDF to preview, share or save to Files. Built
/// from the device's own log, so it works offline and includes entries not yet synced.
struct LogExportSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let initialDay: Date

    @State private var from = Date()
    @State private var to = Date()
    @State private var pdfURL: URL?
    @State private var previewURL: URL?
    @State private var error: String?
    @State private var loaded = false
    @State private var creating = false

    private static let presets = [7, 14, 30, 90]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(Self.presets, id: \.self) { days in
                                Button("Last \(days) days") {
                                    from = Calendar.current.date(byAdding: .day, value: -(days - 1), to: to) ?? to
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                    DatePicker("From", selection: $from, displayedComponents: .date)
                    DatePicker("To", selection: $to, displayedComponents: .date)
                } footer: {
                    Text("Every logged meal in the range, day by day, with BG, carbs against your goals, doses and what was eaten.")
                }
                Section {
                    Button { create() } label: {
                        Label(creating ? "Creating PDF…" : "Create PDF", systemImage: "doc.richtext")
                    }
                    .disabled(creating)
                    if let pdfURL {
                        Button { previewURL = pdfURL } label: { Label("Preview", systemImage: "eye") }
                        ShareLink(item: pdfURL) { Label("Share or save PDF", systemImage: "square.and.arrow.up") }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Export log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .quickLookPreview($previewURL)
            .onAppear {
                guard !loaded else { return }
                loaded = true
                to = initialDay
                from = Calendar.current.date(byAdding: .day, value: -6, to: initialDay) ?? initialDay
            }
            // A PDF of a different range must never be offered as this one.
            .onChange(of: from) { pdfURL = nil }
            .onChange(of: to) { pdfURL = nil }
        }
    }

    private func create() {
        creating = true
        Task {
            await createAsync()
            creating = false
        }
    }

    private func createAsync() async {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: from)
        let lastDay = calendar.startOfDay(for: to)
        guard start <= lastDay else {
            error = "The start date is after the end date."
            return
        }
        do {
            let end = calendar.date(byAdding: .day, value: 1, to: lastDay)!
            let entries = try app.store.logEntries(from: ms(start), to: ms(end))
            let items = try app.store.logItems(entryIds: entries.map(\.id))
            let versions = eligibleDoseSettingsVersions(try app.store.doseSettingsVersions(),
                                                        rejectedIds: try app.store.rejectedDoseSettingsIds())
            // Same precedence as the web Log: the entry's own settings version, else whatever was
            // active when it was eaten.
            let goal = { (entry: LogEntryData) -> CarbGoal? in
                let settings = versions.first { $0.id == entry.settingsVersionId } ?? activeSettings(versions, entry.eatenAt)
                return settings?.windows.first { $0.name == entry.windowName }?.carbGoal
            }
            let report = LogReportBuilder.report(
                from: start, to: lastDay, entries: entries, itemsByEntry: items, catalog: try app.store.catalog(),
                goal: goal, time: { $0.formatted(date: .omitted, time: .shortened) })
            let labels = ReportLabels(
                range: LogReportBuilder.rangeLabel(from: start, to: lastDay),
                generated: Date().formatted(date: .abbreviated, time: .shortened),
                day: { key in
                    let parts = key.split(separator: "-").compactMap { Int($0) }
                    guard parts.count == 3,
                          let day = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
                    else { return key }
                    return day.formatted(.dateTime.weekday(.wide).month(.wide).day())
                })
            // CGM history is fetched fresh for the range; offline, the PDF is made without it.
            var history: BgHistory?
            var failure: String?
            do {
                history = try await app.api.bgReadings(fromMs: ms(start), toMs: ms(end))
            } catch {
                failure = "BG history needs a connection, or is unavailable right now."
            }
            let cgm = LogReportBuilder.reportBg(
                history: history, failure: failure, report: report, from: start, to: lastDay,
                hourLabelAt: { date(ms: $0).formatted(.dateTime.hour()) },
                hourLabel: { Calendar.current.date(bySettingHour: $0, minute: 0, second: 0, of: Date())!.formatted(.dateTime.hour()) },
                earliestLabel: { date(ms: $0).formatted(.dateTime.month(.abbreviated).day()) })
            let name = start == lastDay
                ? "CarbBook log \(LogReportBuilder.dayKey(start))"
                : "CarbBook log \(LogReportBuilder.dayKey(start)) to \(LogReportBuilder.dayKey(lastDay))"
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).pdf")
            try PDFRenderer.pdf(html: LogReportHtml.html(report, labels: labels, cgm: cgm)).write(to: url, options: .atomic)
            error = nil
            pdfURL = url
            previewURL = url
        } catch {
            self.error = "Could not create the PDF: \(error.localizedDescription)"
        }
    }
}

/// HTML → paginated US Letter PDF through the system print renderer, without showing anything.
enum PDFRenderer {
    static func pdf(html: String) -> Data {
        let page = CGRect(x: 0, y: 0, width: 612, height: 792)
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(UIMarkupTextPrintFormatter(markupText: html), startingAtPageAt: 0)
        // The print renderer only exposes these as read-only; KVC is the documented-in-practice way
        // to size it for off-screen rendering. 0.55 in sides, 0.6 in top and bottom.
        renderer.setValue(page, forKey: "paperRect")
        renderer.setValue(page.inset(by: UIEdgeInsets(top: 43, left: 40, bottom: 43, right: 40)), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, page, nil)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
        for index in 0..<renderer.numberOfPages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: index, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        return data as Data
    }
}
