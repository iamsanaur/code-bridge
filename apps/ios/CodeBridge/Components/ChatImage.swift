import CodeBridgeKit
import SwiftUI
import UIKit

/// Where chat images come from: the session's computer and project. Absent for sessions with no project (cloud).
struct ImageSource {
    var scope: String
    var load: @MainActor (String) async throws -> Data
}

extension EnvironmentValues {
    @Entry var imageSource: ImageSource?
}

@MainActor
private enum ImageCache {
    static let cache = NSCache<NSString, UIImage>()
}

/// A screenshot or picture that Claude saved or read in the project, fetched from the computer on demand.
struct ChatImage: View {
    let path: String
    @Environment(\.imageSource) private var source
    @State private var image: UIImage?
    @State private var failure: String?
    @State private var enlarged = false

    private var name: String { path.split(separator: "/").last.map(String.init) ?? path }

    var body: some View {
        if let source {
            Group {
                if let image {
                    VStack(alignment: .leading, spacing: 4) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 260)
                            .clipShape(.rect(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
                            .onTapGesture { enlarged = true }
                            .accessibilityLabel("Image \(name)")
                            .accessibilityHint("Opens it full screen")
                            .accessibilityAddTraits(.isButton)
                        Text(name).font(.caption).foregroundStyle(.secondary)
                    }
                } else if let failure {
                    Label("\(name): \(failure)", systemImage: "photo.badge.exclamationmark")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text(name).font(.caption).foregroundStyle(.secondary) }
                }
            }
            .task(id: "\(source.scope)|\(path)") { await load(source) }
            .fullScreenCover(isPresented: $enlarged) { if let image { ImageViewer(image: image, name: name) } }
        }
    }

    private func load(_ source: ImageSource) async {
        let key = "\(source.scope)|\(path)" as NSString
        if let cached = ImageCache.cache.object(forKey: key) { image = cached; return }
        do {
            let data = try await source.load(path)
            guard let decoded = UIImage(data: data) else { failure = "not a picture"; return }
            ImageCache.cache.setObject(decoded, forKey: key)
            image = decoded
        } catch {
            failure = (error as? APIError)?.message ?? "could not be loaded"
        }
    }
}

/// Full-screen picture with pinch to zoom and double-tap to zoom in or out.
private struct ImageViewer: View {
    let image: UIImage
    let name: String
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            ScrollView([.horizontal, .vertical], showsIndicators: false) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .containerRelativeFrame(.horizontal) { w, _ in w * max(1, scale * pinch) }
                    .gesture(MagnifyGesture().updating($pinch) { value, state, _ in state = value.magnification }
                        .onEnded { value in scale = min(6, max(1, scale * value.magnification)) })
                    .onTapGesture(count: 2) { withAnimation(.snappy) { scale = scale > 1 ? 1 : 2.5 } }
            }
            HStack {
                ShareLink(item: Image(uiImage: image), preview: SharePreview(name, image: Image(uiImage: image)))
                Button { dismiss() } label: { Image(systemName: "xmark.circle.fill").font(.title) }
                    .accessibilityLabel("Close")
            }
            .padding()
            .foregroundStyle(.white)
        }
    }
}
