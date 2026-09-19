import CarbBookKit
import PhotosUI
import SwiftUI

/// Picks one image for a food or meal (images spec). It only ever reports the chosen image id: the
/// caller saves it on the record through its ordinary save path, so the edit queues offline and
/// resolves by last-write-wins like any other field.
///
/// Every failure leaves the sheet open with the message inline, so the user can pick something else
/// without starting over.
struct ImagePickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let imageID: String?
    /// Prefills the search box — the food or meal name as it currently stands in the editor.
    let defaultQuery: String
    let onChange: (String?) -> Void

    /// nil means "follow the food or meal's name". Holding the typed value separately, rather than
    /// seeding state once, matters for a NEW food: the name is typically still empty when the editor
    /// first builds this sheet, so a seed-once would leave the box blank and Search disabled until
    /// the user retyped the name they had just entered.
    @State private var typed: String?
    @State private var result: ImageSearchResult?
    @State private var photo: PhotosPickerItem?
    @State private var showCamera = false
    @State private var busy = false
    @State private var error: String?

    private var query: String { typed ?? defaultQuery }
    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                if imageID != nil {
                    Section {
                        ImageThumbView(imageID: imageID, size: 120, shape: .rounded)
                        // Removing only clears this record's reference; the stored image row is
                        // shared with anything else pointing at it and is left alone.
                        Button("Remove image", role: .destructive) { choose(nil) }
                            .disabled(busy)
                    }
                }
                Section("Search") {
                    TextField("Search for an image", text: Binding(get: { query }, set: { typed = $0 }))
                        .textInputAutocapitalization(.never)
                        .submitLabel(.search)
                        .onSubmit { search() }
                    Button("Search") { search() }
                        .disabled(busy || trimmed.isEmpty)
                }
                Section("Your own photo") {
                    PhotosPicker("Choose a photo", selection: $photo, matching: .images)
                        .disabled(busy)
                    Button("Take a photo") { showCamera = true }
                        .disabled(busy)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                resultsSection
            }
            .navigationTitle("Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                if busy { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
            }
            .sheet(isPresented: $showCamera) {
                CameraPicker { image in
                    showCamera = false
                    if let image { upload(image) }
                }
                .ignoresSafeArea()
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                load(item)
            }
        }
    }

    @ViewBuilder private var resultsSection: some View {
        if let result {
            Section {
                if result.candidates.isEmpty {
                    Text("No images found.").foregroundStyle(.secondary)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 8)], spacing: 8) {
                        ForEach(result.candidates) { candidate in
                            Button { adopt(candidate) } label: {
                                CandidateThumb(candidate: candidate)
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .accessibilityLabel(candidate.title ?? "Image from \(candidate.provider)")
                        }
                    }
                }
            } footer: {
                // A dead provider is a quiet note, not an error: the other providers still answered.
                VStack(alignment: .leading) {
                    ForEach(result.providersFailed, id: \.self) { Text("No response from \($0).") }
                }
            }
        }
    }

    /// Runs one request with the busy flag and inline error handling every action shares.
    private func run(_ action: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do {
                try await action()
            } catch {
                self.error = "\(error)"
            }
            busy = false
        }
    }

    private func search() {
        let text = trimmed
        guard !text.isEmpty else { return }
        // `searchImages` never throws; a dead search arrives as a failed "server" provider.
        run { result = await app.api.searchImages(query: text, limit: 24) }
    }

    private func adopt(_ candidate: ImageCandidate) {
        run { choose(try await app.api.adoptImage(candidate).id) }
    }

    private func load(_ item: PhotosPickerItem) {
        run {
            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                throw ImagePickerError("That photo could not be read.")
            }
            photo = nil
            try await send(image)
        }
    }

    private func upload(_ image: UIImage) {
        run { try await send(image) }
    }

    private func send(_ image: UIImage) async throws {
        guard let base64 = PhotoEncoder.jpegBase64(image) else {
            throw ImagePickerError("That photo could not be prepared for upload.")
        }
        choose(try await app.api.uploadImage(dataBase64: base64).id)
    }

    private func choose(_ id: String?) {
        onChange(id)
        dismiss()
    }
}

struct ImagePickerError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// A provider's own thumbnail, loaded straight from the provider (nothing is stored until adopt).
private struct CandidateThumb: View {
    let candidate: ImageCandidate

    var body: some View {
        AsyncImage(url: URL(string: candidate.thumbUrl)) { phase in
            if let image = phase.image {
                image.resizable().aspectRatio(contentMode: .fill)
            } else if phase.error != nil {
                // A provider thumbnail that will not load is just an empty tile: the rest of the
                // grid is still usable.
                Color.clear
            } else {
                ProgressView()
            }
        }
        .frame(width: 90, height: 90)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// The camera, which SwiftUI has no view of its own for. One photo, no editing. It reports nil on
/// cancel so the presenter can close the sheet on either outcome without reading the environment
/// from inside the representable (where it is captured once, at `makeCoordinator` time).
private struct CameraPicker: UIViewControllerRepresentable {
    let onFinish: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onFinish: (UIImage?) -> Void

        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(nil)
        }
    }
}
