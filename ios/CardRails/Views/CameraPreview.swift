import AVFoundation
import SwiftUI

/// Hosts the live `AVCaptureVideoPreviewLayer` as a full-bleed SwiftUI view.
struct CameraPreview: UIViewRepresentable {
    let previewLayer: AVCaptureVideoPreviewLayer

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black
        previewLayer.videoGravity = .resizeAspectFill
        view.host(previewLayer)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.setNeedsLayout()
    }

    final class PreviewView: UIView {
        private weak var previewLayer: AVCaptureVideoPreviewLayer?

        func host(_ layer: AVCaptureVideoPreviewLayer) {
            previewLayer = layer
            layer.removeFromSuperlayer()
            self.layer.addSublayer(layer)
            setNeedsLayout()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            previewLayer?.frame = bounds
        }
    }
}
