import SwiftUI

enum LoadState<Value> {
    case loading
    case failed(Error)
    case loaded(Value)

    var value: Value? {
        if case let .loaded(v) = self { return v }
        return nil
    }
}

/// Loads data with loading / error / content states, pull-to-refresh, and an
/// optional `reloadTrigger` so realtime events can refresh it.
struct AsyncContent<Value, Content: View>: View {
    private let load: () async throws -> Value
    private let reloadTrigger: Int
    private let content: (Value) -> Content
    @State private var state: LoadState<Value> = .loading

    init(load: @escaping () async throws -> Value, reloadTrigger: Int = 0, @ViewBuilder content: @escaping (Value) -> Content) {
        self.load = load
        self.reloadTrigger = reloadTrigger
        self.content = content
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
            case let .failed(error):
                ErrorStateView(error: error) { Task { await reload() } }
            case let .loaded(value):
                content(value)
            }
        }
        .task(id: reloadTrigger) { await reload() }
    }

    private func reload() async {
        do {
            state = .loaded(try await load())
        } catch is CancellationError {
        } catch {
            // Keep showing data we already have; only a failed first load shows the error.
            if state.value == nil { state = .failed(error) }
        }
    }
}

struct ErrorStateView: View {
    let error: Error
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn’t load", systemImage: "exclamationmark.triangle")
        } description: {
            Text(error.localizedDescription)
        } actions: {
            Button("Retry", action: retry).buttonStyle(.glass)
        }
    }
}

/// Runs async button actions with busy and error state.
@MainActor
@Observable
final class ActionRunner {
    var busy = false
    var error: String?

    func run(_ work: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do { try await work() } catch { self.error = error.localizedDescription }
        }
    }
}

struct InlineError: View {
    let message: String?
    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(Palette.danger)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}
