import AVFoundation
import CoreGraphics
import Foundation
import QuartzCore

/// Owns the `AVCaptureSession`, runs Vision detection and recognition on a
/// dedicated serial queue, and reports results back on the main queue.
///
/// Recognition state (`recognizer`) is injected from the UI layer and guarded
/// by a lock because it may be replaced on the main queue while the video
/// queue reads it.
final class CameraController: NSObject, ObservableObject {
    let session = AVCaptureSession()
    let previewLayer: AVCaptureVideoPreviewLayer

    private let sessionQueue = DispatchQueue(label: "com.cardrails.camera.session")
    private let videoQueue = DispatchQueue(label: "com.cardrails.camera.video")
    private let detector = CardDetector()
    private var stabilizer = FrameStabilizer()

    private var device: AVCaptureDevice?
    private var emptyFrameCount = 0
    private var identifiedThisPlacement = false
    private var lastProcessedAt: CFTimeInterval = 0
    private static let minFrameInterval: CFTimeInterval = 0.08
    /// Center of the card that was last identified; a big jump means a new card.
    private var identifiedCenter: CGPoint?
    private var configured = false
    private var pauseDepth = 0

    private let stateLock = NSLock()
    private var activeRecognizer: Recognizer?
    private var torchOn = false

    // MARK: Callbacks (invoked on the main queue)

    var onDetection: ((DetectedCard?) -> Void)?
    var onFrameEmpty: (() -> Void)?
    var onAccepted: ((Match, CGImage, Double) -> Void)?
    var onReview: (([Match]) -> Void)?
    var onPermissionDenied: (() -> Void)?

    override init() {
        self.previewLayer = AVCaptureVideoPreviewLayer(session: session)
        super.init()
        previewLayer.videoGravity = .resizeAspectFill
    }

    // MARK: - Recognition wiring

    func setRecognizer(_ recognizer: Recognizer?) {
        stateLock.lock()
        activeRecognizer = recognizer
        stateLock.unlock()
    }

    private var recognizer: Recognizer? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return activeRecognizer
    }

    // MARK: - Lifecycle

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureAndStart()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard let self else { return }
                if granted {
                    self.configureAndStart()
                } else {
                    DispatchQueue.main.async { self.onPermissionDenied?() }
                }
            }
        default:
            DispatchQueue.main.async { [weak self] in self?.onPermissionDenied?() }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    /// Pause recognition (e.g. while the candidate picker is on screen).
    func pause() {
        stateLock.lock()
        pauseDepth += 1
        stateLock.unlock()
    }

    func resume() {
        stateLock.lock()
        pauseDepth = max(0, pauseDepth - 1)
        stateLock.unlock()
        videoQueue.async { [weak self] in
            guard let self else { return }
            // The reviewed card is usually still in frame: keep it marked as
            // identified so the picker does not reopen; removing it resets.
            self.stabilizer.reset()
        }
    }

    func setTorch(_ on: Bool) {
        stateLock.lock()
        torchOn = on
        stateLock.unlock()
        sessionQueue.async { [weak self] in
            guard let self, let device = self.device, device.hasTorch else { return }
            guard (try? device.lockForConfiguration()) != nil else { return }
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        }
    }

    private var isPaused: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return pauseDepth > 0
    }

    // MARK: - Session configuration

    private func configureAndStart() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if !self.configured {
                self.configure()
                self.configured = true
            }
            guard !self.session.isRunning else { return }
            self.session.startRunning()
            if self.isTorchRequested {
                self.applyTorch(true)
            }
        }
    }

    private var isTorchRequested: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return torchOn
    }

    private func configure() {
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080

        guard
            let device = AVCaptureDevice.default(
                .builtInWideAngleCamera,
                for: .video,
                position: .back
            ),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            session.commitConfiguration()
            return
        }
        session.addInput(input)
        self.device = device

        if (try? device.lockForConfiguration()) != nil {
            if device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusMode = .continuousAutoFocus
            }
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
            device.unlockForConfiguration()
        }

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: videoQueue)
        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        session.commitConfiguration()
    }

    private func applyTorch(_ on: Bool) {
        guard let device, device.hasTorch else { return }
        guard (try? device.lockForConfiguration()) != nil else { return }
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
    }

    // MARK: - Frame pipeline

    private func process(_ pixelBuffer: CVPixelBuffer) {
        guard !isPaused else { return }

        // Keep detecting after an identification: that is how a removed or
        // swapped card is noticed and the next one gets scanned.
        let card = try? detector.detect(in: pixelBuffer, orientation: .right)
        guard let card else {
            emptyFrameCount += 1
            if emptyFrameCount >= 4 {
                stabilizer.reset()
                identifiedThisPlacement = false
                identifiedCenter = nil
                DispatchQueue.main.async { [weak self] in
                    self?.onFrameEmpty?()
                    self?.onDetection?(nil)
                }
            }
            return
        }

        emptyFrameCount = 0
        DispatchQueue.main.async { [weak self] in self?.onDetection?(card) }

        let center = Self.center(of: card.quad)
        if identifiedThisPlacement {
            guard let previous = identifiedCenter,
                  hypot(center.x - previous.x, center.y - previous.y) > 0.15
            else { return }
            // The card moved far: treat it as a new placement.
            identifiedThisPlacement = false
            identifiedCenter = nil
            stabilizer.reset()
            DispatchQueue.main.async { [weak self] in self?.onFrameEmpty?() }
        }

        guard stabilizer.observe(card.quad) else { return }
        guard let recognizer else { return }

        let started = Date()
        guard let matches = try? recognizer.identify(card.image) else { return }
        let ms = Date().timeIntervalSince(started) * 1000
        let verdict = recognizer.verdict(matches)

        stabilizer.reset()
        if case .none = verdict { return }  // retry on the next stable frames
        identifiedThisPlacement = true
        identifiedCenter = center

        switch verdict {
        case .accepted(let match):
            DispatchQueue.main.async { [weak self] in
                self?.onAccepted?(match, card.image, ms)
            }
        case .review(let candidates):
            DispatchQueue.main.async { [weak self] in
                self?.onReview?(candidates)
            }
        case .none:
            break
        }
    }
}

extension CameraController {
    static func center(of quad: [CGPoint]) -> CGPoint {
        guard !quad.isEmpty else { return .zero }
        let sum = quad.reduce(CGPoint.zero) { CGPoint(x: $0.x + $1.x, y: $0.y + $1.y) }
        return CGPoint(x: sum.x / CGFloat(quad.count), y: sum.y / CGFloat(quad.count))
    }
}

extension CameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        // ~12 fps is plenty for a card held still and keeps the phone cool.
        let now = CACurrentMediaTime()
        guard now - lastProcessedAt >= Self.minFrameInterval else { return }
        lastProcessedAt = now
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        process(pixelBuffer)
    }
}
