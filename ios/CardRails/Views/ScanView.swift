import AVFoundation
import CoreGraphics
import SwiftUI
import UIKit

/// Menu label styled like the web app's small selector pills.
struct PillLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Text(text).font(.subheadline.weight(.semibold))
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
        }
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 9))
    }
}

struct ScanView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var camera = CameraController()

    @State private var quad: [CGPoint]?
    @State private var candidates: [Match]?
    @State private var permissionDenied = false
    @State private var torchOn = false
    @State private var flash = false
    @State private var showStorageSheet = false
    @State private var editingLine: ScanLine?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            CameraPreview(previewLayer: camera.previewLayer)
                .ignoresSafeArea()

            CardQuadOverlay(previewLayer: camera.previewLayer, quad: quad, flash: flash)
                .ignoresSafeArea()

            if permissionDenied {
                permissionView
            }

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 0)
                ScanTray(session: model.scanSession, editing: $editingLine)
            }
        }
        .overlay(alignment: .bottom) {
            if let candidates {
                CandidatePicker(
                    matches: candidates,
                    onPick: { match in
                        model.addCandidate(match)
                        dismissCandidates()
                    },
                    onIgnore: dismissCandidates
                )
                .padding(.bottom, 8)
            }
        }
        .sheet(isPresented: $showStorageSheet) {
            StorageSettingsSheet()
                .environmentObject(model)
        }
        .sheet(item: $editingLine) { line in
            ScanLineSheet(line: line, session: model.scanSession)
                .presentationDetents([.height(260)])
        }
        .sheet(isPresented: $model.needsStorageSetup) {
            StorageSettingsSheet()
                .environmentObject(model)
        }
        .onReceive(model.$recognizer) { camera.setRecognizer($0) }
        .onChange(of: model.acceptedFlash) { _, _ in
            flash = true
            Task {
                try? await Task.sleep(nanoseconds: 260_000_000)
                flash = false
            }
        }
        .task {
            camera.onDetection = { card in
                Task { @MainActor in
                    withAnimation(.linear(duration: 0.08)) { quad = card?.quad }
                }
            }
            camera.onFrameEmpty = {
                Task { @MainActor in
                    model.markFrameEmpty()
                    quad = nil
                }
            }
            camera.onAccepted = { match, crop, ms in
                Task { @MainActor in model.handleAccepted(match: match, crop: crop, ms: ms) }
            }
            camera.onReview = { matches in
                Task { @MainActor in
                    camera.pause()
                    candidates = Array(matches.prefix(3))
                }
            }
            camera.onPermissionDenied = {
                Task { @MainActor in permissionDenied = true }
            }
            camera.setRecognizer(model.recognizer)
            camera.start()
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            camera.stop()
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                camera.start()
                UIApplication.shared.isIdleTimerDisabled = true
            case .background:
                camera.stop()
                UIApplication.shared.isIdleTimerDisabled = false
            default: break
            }
        }
    }

    private func dismissCandidates() {
        candidates = nil
        camera.resume()
    }

    // MARK: - Top bar

    private var topBar: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Menu { gameMenu } label: { pill(gameName) }
                Menu { languageMenu } label: { pill(model.language) }
                Spacer()
                Menu { finishMenu } label: { pill(model.printing) }
                Button {
                    torchOn.toggle()
                    camera.setTorch(torchOn)
                } label: {
                    Image(systemName: torchOn ? "bolt.fill" : "bolt.slash")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(torchOn ? Theme.accent : Theme.text)
                        .frame(width: 38, height: 34)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 9))
                }
            }

            Picker("Condizione", selection: conditionBinding) {
                ForEach(Conditions.all, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.segmented)

            VStack(spacing: 4) {
                HStack {
                    catalogStatus
                    Spacer()
                    if model.lastRecognitionMs > 0 {
                        Text("\(Int(model.lastRecognitionMs.rounded())) ms")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Theme.muted)
                    }
                }
                HStack {
                    locationStatus
                    Spacer()
                }
            }
        }
        .padding(12)
        .background(Theme.header.opacity(0.92))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func pill(_ text: String) -> PillLabel {
        PillLabel(text: text)
    }

    private var gameName: String {
        Game.all.first(where: { $0.id == model.game })?.name ?? model.game
    }

    @ViewBuilder private var gameMenu: some View {
        ForEach(Game.all) { game in
            Button {
                model.setGame(game.id)
            } label: {
                if model.game == game.id {
                    Label(game.name, systemImage: "checkmark")
                } else {
                    Text(game.name)
                }
            }
        }
    }

    @ViewBuilder private var languageMenu: some View {
        ForEach(model.availableLanguages(), id: \.self) { code in
            Button {
                model.setLanguage(code)
            } label: {
                if model.language == code {
                    Label(code, systemImage: "checkmark")
                } else {
                    Text(code)
                }
            }
        }
    }

    @ViewBuilder private var finishMenu: some View {
        ForEach(Finishes.all, id: \.self) { finish in
            Button {
                model.setPrinting(finish)
            } label: {
                if model.printing == finish {
                    Label(finish, systemImage: "checkmark")
                } else {
                    Text(finish)
                }
            }
        }
    }

    private var conditionBinding: Binding<String> {
        Binding(get: { model.condition }, set: { model.setCondition($0) })
    }

    @ViewBuilder private var catalogStatus: some View {
        switch model.catalogState {
        case .idle:
            statusLabel("Catalogo…", systemImage: "arrow.triangle.2.circlepath")
        case .downloading(let progress):
            statusLabel("Scarico catalogo \(Int((progress * 100).rounded()))%", systemImage: "arrow.down.circle")
        case .loading:
            statusLabel("Carico catalogo…", systemImage: "clock")
        case .ready(let entry):
            statusLabel(
                "\(gameName) \(model.language) · \(Format.count(entry.count)) carte",
                systemImage: "checkmark.seal"
            )
        case .failed(let message):
            HStack(spacing: 8) {
                statusLabel(message, systemImage: "exclamationmark.triangle")
                Button("Riprova") { model.retryCatalog() }
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Theme.accent)
            }
        }
    }

    private func statusLabel(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(Theme.muted)
            .lineLimit(1)
    }

    @ViewBuilder private var locationStatus: some View {
        if
            let settings = model.scanSettings,
            settings.locationConfigured,
            !settings.storageLabel.isEmpty
        {
            let stack = settings.stackSize.map { "\(settings.stack)/\($0)" } ?? "\(settings.stack)"
            statusLabel("\(settings.storageLabel) · \(stack)", systemImage: "shippingbox")
        } else {
            Button {
                showStorageSheet = true
            } label: {
                Label("Imposta posizione", systemImage: "plus.circle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
        }
    }

    private var permissionView: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill").font(.system(size: 42)).foregroundStyle(Theme.muted)
            Text("Serve l'accesso alla fotocamera")
                .font(.display(20))
                .foregroundStyle(Theme.text)
            Text("Consenti l'accesso alla fotocamera dalle Impostazioni per scansionare le carte.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Apri Impostazioni", destination: url)
                    .font(.headline)
                    .foregroundStyle(Theme.accent)
            }
        }
        .padding(32)
        .background(Theme.background.opacity(0.94))
        .ignoresSafeArea()
    }
}

/// Red (or green on accept) quad tracking the detected card.
struct CardQuadOverlay: View {
    let previewLayer: AVCaptureVideoPreviewLayer
    let quad: [CGPoint]?
    let flash: Bool

    var body: some View {
        GeometryReader { _ in
            if let quad, quad.count == 4 {
                let points = quad.map {
                    previewLayer.layerPointConverted(fromCaptureDevicePoint: $0)
                }
                Path { path in
                    path.addLines(points)
                    path.closeSubpath()
                }
                .stroke(
                    flash ? Color.green : Theme.accent,
                    style: StrokeStyle(lineWidth: 3, lineJoin: .round)
                )
                .shadow(color: (flash ? Color.green : Theme.accent).opacity(0.6), radius: 6)
                .animation(.easeOut(duration: 0.15), value: flash)
            }
        }
        .allowsHitTesting(false)
    }
}

/// Small sheet to change a scan line's quantity or remove it.
struct ScanLineSheet: View {
    let line: ScanLine
    @ObservedObject var session: ScanSession
    @Environment(\.dismiss) private var dismiss

    @State private var quantity: Int

    init(line: ScanLine, session: ScanSession) {
        self.line = line
        self.session = session
        _quantity = State(initialValue: line.quantity)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text(line.record.name)
                    .font(.display(20))
                    .foregroundStyle(Theme.text)
                Stepper(value: $quantity, in: 1...10000) {
                    Text("Quantità: \(quantity)").foregroundStyle(Theme.text)
                }
                .padding(.horizontal)

                Button(role: .destructive) {
                    session.remove(id: line.id)
                    dismiss()
                } label: {
                    Text("Rimuovi").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .padding(.horizontal)
            }
            .padding(.top, 24)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Theme.background)
            .onChange(of: quantity) { _, value in
                session.setQuantity(id: line.id, n: value)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fatto") { dismiss() }
                }
            }
        }
    }
}
