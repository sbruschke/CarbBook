import AVFoundation
import SwiftUI
import UIKit
import VisionKit

/// VisionKit live barcode scanner (spec §8). Reports the first 6–14 digit code once.
///
/// Camera access is requested first (`AVCaptureDevice.requestAccess`); `DataScannerViewController`
/// `isSupported`/`isAvailable` are only checked after that, because `isAvailable` stays false until
/// access is granted. When access is denied the view explains it with a link to Settings; the
/// barcode-digits field below the scanner (BarcodeFlowView) remains the manual fallback.
/// Verify on device: first-launch prompt, denied → Settings link, granted → live scanning.
struct BarcodeScannerView: View {
    let onScan: (String) -> Void

    /// Always true: the permission request and the VisionKit capability checks happen inside the view.
    static var isUsable: Bool { true }

    private enum Access {
        case checking, granted, denied
    }

    @State private var access: Access = .checking

    var body: some View {
        Group {
            switch access {
            case .checking:
                ProgressView("Requesting camera access…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .granted:
                if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    DataScannerRepresentable(onScan: onScan)
                } else {
                    ContentUnavailableView("Camera scanning unavailable", systemImage: "barcode.viewfinder",
                                           description: Text("Type the barcode digits instead."))
                }
            case .denied:
                ContentUnavailableView {
                    Label("Camera access is off", systemImage: "camera")
                } description: {
                    Text("Allow camera access for CarbBook in Settings to scan barcodes, or type the barcode digits instead.")
                } actions: {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        Link("Open Settings", destination: url)
                    }
                }
            }
        }
        .task { await requestAccess() }
    }

    private func requestAccess() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            access = .granted
        case .notDetermined:
            access = await AVCaptureDevice.requestAccess(for: .video) ? .granted : .denied
        default:
            access = .denied
        }
    }
}

private struct DataScannerRepresentable: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.ean13, .ean8, .upce, .code128, .itf14])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning {
            try? scanner.startScanning()
        }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        private var delivered = false

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for item in addedItems {
                guard case .barcode(let barcode) = item, let payload = barcode.payloadStringValue,
                      (6...14).contains(payload.count), payload.allSatisfy({ $0.isASCII && $0.isNumber }) else { continue }
                delivered = true
                dataScanner.stopScanning()
                onScan(payload)
                return
            }
        }
    }
}
