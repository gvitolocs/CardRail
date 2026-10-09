# Card Rails Android — Task 12

Build verification completed with:

```text
JAVA_HOME=~/tools/jdk-21.0.12.1+1 ANDROID_HOME=~/Android/Sdk ./gradlew --no-daemon testDebugUnitTest assembleDebug
BUILD SUCCESSFUL
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk` — **46,785,536 bytes**

## Kotlin line counts

```text
  57 app/src/main/java/com/pokoin/cardrails/api/APIClient.kt
  31 app/src/main/java/com/pokoin/cardrails/api/Models.kt
  16 app/src/main/java/com/pokoin/cardrails/api/TokenStore.kt
  91 app/src/main/java/com/pokoin/cardrails/camera/CameraAnalyzer.kt
  48 app/src/main/java/com/pokoin/cardrails/camera/CameraController.kt
  54 app/src/main/java/com/pokoin/cardrails/camera/CardDetector.kt
 180 app/src/main/java/com/pokoin/cardrails/engine/Catalog.kt
  60 app/src/main/java/com/pokoin/cardrails/engine/Embedder.kt
  40 app/src/main/java/com/pokoin/cardrails/engine/FrameStabilizer.kt
  38 app/src/main/java/com/pokoin/cardrails/engine/Games.kt
  29 app/src/main/java/com/pokoin/cardrails/engine/Recognizer.kt
  40 app/src/main/java/com/pokoin/cardrails/engine/ScanSession.kt
  52 app/src/main/java/com/pokoin/cardrails/engine/ServerScanClient.kt
  96 app/src/main/java/com/pokoin/cardrails/engine/VectorIndex.kt
  20 app/src/main/java/com/pokoin/cardrails/MainActivity.kt
  64 app/src/main/java/com/pokoin/cardrails/state/AppModel.kt
  23 app/src/main/java/com/pokoin/cardrails/state/Persistence.kt
 116 app/src/main/java/com/pokoin/cardrails/ui/CardRailsApp.kt
  48 app/src/test/java/com/pokoin/cardrails/engine/EngineTest.kt
1103 total
```
