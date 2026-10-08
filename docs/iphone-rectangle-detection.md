# iPhone rectangle detection — 2026-10-08

The native iPhone app introduced in `278c7af` uses Apple Vision rather than the
Flutter scanner's YOLO model. The subsequent `2e8e560` commit limits camera
processing to about 12 fps; it did not change the rectangle detector.

The original detector requested one observation, gated Vision's candidate search
at confidence 0.6 and used the first result directly. Running it on the existing
real One Piece photo (`ios/CardRailsTests/Fixtures/card.jpg`) produced no rectangle;
the still-photo method silently used its center-crop fallback. The live-frame
method returned nil, preventing both the overlay and recognition.

The revised detector requests multiple candidates and applies the Pokoin Single
geometry rules explicitly:

- 63:88 card aspect limits of 0.58–0.88, measured using quad edge lengths in pixels;
- normalized area 0.12–0.72, confidence >= 0.70 and center offset <= 0.28;
- rejection of frame borders, small labels, peripheral shapes and nested artwork;
- follow the same outer card at IoU >= 0.40; release after eight missed frames;
- perspective-correct the detected corners and keep the existing two-frame
  recognition stabilizer.

The camera output rotation is explicitly zero, so `.right` is applied once when
creating the upright image. These changes do not make Vision a semantic object
classifier: recognition still validates the card against the selected catalog.

Diagnostic events are kept locally in `Library/Caches/cardrails-scan.log` (bounded
at 256 KiB). The log records frame status, orientation, rectangle count, geometry,
selected candidate, recognition scores and failures. It contains no photos,
account tokens or card inventory payloads.

Verification: all 50 XCTest cases completed with zero failures; 49 passed and the
unsigned simulator Keychain test was skipped. Seven new cases cover actual photo
corners, the landscape sensor-frame path, pixel geometry, nested artwork, invalid
shapes, rotated cards and persistent object selection. The signed iPhone build
also succeeded.
