package com.pokoin.cardrails.ui

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import coil.compose.AsyncImage
import com.pokoin.cardrails.camera.CameraAnalyzer
import com.pokoin.cardrails.camera.CameraController
import com.pokoin.cardrails.camera.CardDetector
import com.pokoin.cardrails.engine.Conditions
import com.pokoin.cardrails.engine.Finishes
import com.pokoin.cardrails.engine.Games
import com.pokoin.cardrails.engine.Languages
import com.pokoin.cardrails.engine.Match
import com.pokoin.cardrails.engine.Point
import com.pokoin.cardrails.state.AppModel
import com.pokoin.cardrails.state.CatalogStatus
import com.pokoin.cardrails.state.TrayLine
import kotlinx.coroutines.delay

@Composable
fun ScanScreen(model: AppModel) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }

    // Keep the screen on while scanning.
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    val candidates by model.candidates.collectAsState()
    val needsStorage by model.needsStorage.collectAsState()

    Column(Modifier.fillMaxSize().background(CR.Background)) {
        ScanControls(model)
        Box(Modifier.fillMaxWidth().weight(1f)) {
            if (granted) CameraBox(model) else PermissionPanel { ask.launch(Manifest.permission.CAMERA) }
            candidates?.let { CandidatePicker(it, model::chooseCandidate, model::dismissCandidates, Modifier.align(Alignment.BottomCenter)) }
        }
        TrayPanel(model)
    }
    if (needsStorage) StorageDialog(model)
}

@Composable
private fun ScanControls(model: AppModel) {
    val game by model.game.collectAsState()
    val language by model.language.collectAsState()
    val condition by model.condition.collectAsState()
    val printing by model.printing.collectAsState()
    val index by model.catalogIndex.collectAsState()
    val status by model.catalogStatus.collectAsState()
    val lastScan by model.lastScan.collectAsState()
    val settings by model.settings.collectAsState()
    val languages = index?.languagesFor(game) ?: Languages.all

    Column(Modifier.fillMaxWidth().background(CR.Header).padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Picker(Games.name(game), Games.all.map { it.id to it.name }, model::setGame)
            Picker(language, languages.map { it to it }, model::setLanguage)
            Picker(printing, Finishes.all.map { it to it }, model::setPrinting)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Conditions.all.forEach { Chip(it, it == condition) { model.setCondition(it) } }
        }
        val line = when (val s = status) {
            CatalogStatus.Idle -> "Preparo il catalogo…"
            is CatalogStatus.Downloading -> "Scarico catalogo ${(s.progress * 100).toInt()}%"
            CatalogStatus.Loading -> "Carico catalogo…"
            is CatalogStatus.OnDevice -> "GPU · ${Games.name(s.entry.game)} · ${"%,d".format(s.entry.count).replace(',', '.')} carte"
            is CatalogStatus.Server -> "Server nezopt · ${s.reason}"
            is CatalogStatus.Failed -> s.message
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(line + (lastScan?.let { "  ·  ultimo $it" } ?: ""), color = CR.Muted, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                if (settings.locationConfigured) "Box ${settings.storageLabel} · ${settings.stackSize}/pila" else "Imposta posizione",
                color = if (settings.locationConfigured) CR.Muted else CR.Accent, fontSize = 12.sp,
                modifier = Modifier.clickable { model.requestStorage() },
            )
        }
    }
}

@Composable
private fun Picker(label: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Text(
            "$label ▾", color = CR.Text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
            modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(CR.Surface).border(1.dp, CR.Line, RoundedCornerShape(10.dp))
                .clickable { open = true }.padding(horizontal = 12.dp, vertical = 8.dp),
        )
        DropdownMenu(open, { open = false }) {
            options.forEach { (id, name) -> DropdownMenuItem({ Text(name) }, { onPick(id); open = false }) }
        }
    }
}

@Composable
private fun CameraBox(model: AppModel) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val view = LocalView.current
    var quad by remember { mutableStateOf<List<Point>?>(null) }
    var flash by remember { mutableStateOf(false) }
    var torch by remember { mutableStateOf(false) }
    val preview = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            // TextureView respects the Compose box clip; a SurfaceView drew over the controls.
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }
    val detector = remember { runCatching { CardDetector(context) }.getOrNull() }
    val controller = remember(detector) {
        detector?.let {
            CameraController(
                context, owner, preview,
                CameraAnalyzer(
                    detector = it,
                    recognizer = { model.recognizer },
                    serverCatalogId = { model.serverCatalogId },
                    server = model.server,
                    paused = { model.reviewing },
                    onDetection = { card -> preview.post { quad = card?.quad } },
                    onFrameEmpty = {},
                    onResult = { result -> preview.post { model.onScanResult(result) } },
                ),
            )
        }
    }
    DisposableEffect(controller) {
        controller?.start()
        onDispose {
            if (controller != null) controller.stop { detector?.close() } else detector?.close()
        }
    }
    LaunchedEffect(Unit) {
        model.accepted.collect {
            view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
            flash = true; delay(260); flash = false
        }
    }

    Box(Modifier.fillMaxSize().clipToBounds().background(androidx.compose.ui.graphics.Color.Black)) {
        AndroidView({ preview }, Modifier.fillMaxSize())
        androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
            val points = quad ?: return@Canvas
            // Frames are 720×1280 portrait shown with FILL_CENTER.
            val fw = 720f; val fh = 1280f
            val scale = maxOf(size.width / fw, size.height / fh)
            val dx = (fw * scale - size.width) / 2f; val dy = (fh * scale - size.height) / 2f
            fun map(p: Point) = Offset(p.x * fw * scale - dx, p.y * fh * scale - dy)
            val path = Path().apply {
                moveTo(map(points[0]).x, map(points[0]).y)
                points.drop(1).forEach { lineTo(map(it).x, map(it).y) }
                close()
            }
            drawPath(path, if (flash) CR.Success else CR.Accent, style = Stroke(width = 6f))
        }
        if (detector == null) Text("Rilevatore non disponibile", color = CR.Accent, modifier = Modifier.align(Alignment.Center))
        Text(
            if (torch) "Flash ON" else "Flash", color = CR.Text, fontSize = 12.sp,
            modifier = Modifier.align(Alignment.TopEnd).padding(10.dp).clip(RoundedCornerShape(14.dp))
                .background(if (torch) CR.Accent else CR.Surface.copy(alpha = .8f))
                .clickable { torch = !torch; controller?.setTorch(torch) }.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun PermissionPanel(onAsk: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Card Rails usa la fotocamera per riconoscere le tue carte.", color = CR.Text)
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Consenti fotocamera", onAsk)
    }
}

@Composable
private fun TrayPanel(model: AppModel) {
    val tray by model.tray.collectAsState()
    val committing by model.committing.collectAsState()
    val intent by model.intent.collectAsState()
    var editing by remember { mutableStateOf<TrayLine?>(null) }
    val total = tray.sumOf { it.quantity }

    Column(Modifier.fillMaxWidth().background(CR.Header).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (tray.isEmpty()) {
            Text("Inquadra una carta e tienila ferma un istante.", color = CR.Muted, fontSize = 13.sp)
        } else {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(tray, key = { it.id }) { line ->
                    Column(Modifier.width(78.dp).clickable { editing = line }) {
                        Box {
                            AsyncImage(line.art, line.name, Modifier.size(78.dp, 108.dp).clip(RoundedCornerShape(8.dp)).background(CR.Surface), contentScale = ContentScale.Crop)
                            if (line.quantity > 1) Text(
                                "×${line.quantity}", color = CR.Text, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                                modifier = Modifier.align(Alignment.TopEnd).padding(3.dp).clip(RoundedCornerShape(8.dp)).background(CR.Accent).padding(horizontal = 6.dp, vertical = 1.dp),
                            )
                        }
                        Text(line.name, color = CR.Text, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Chip("Vendita", intent == "sale") { model.intent.value = "sale" }
            Chip("Collezione", intent == "collection") { model.intent.value = "collection" }
            Spacer(Modifier.weight(1f))
            if (committing) CircularProgressIndicator(color = CR.Accent, modifier = Modifier.size(28.dp))
            else PrimaryButton("Aggiungi ($total)", model::commit, enabled = tray.isNotEmpty())
        }
    }
    editing?.let { line ->
        var quantity by remember(line.id) { mutableStateOf(line.quantity) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(line.name) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("${line.set} · #${line.number} · ${line.language} · ${line.condition}", color = CR.Muted)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Chip("−", false) { if (quantity > 1) quantity-- }
                        Text("$quantity", color = CR.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Chip("+", false) { quantity++ }
                    }
                }
            },
            confirmButton = { TextButton({ model.setQuantity(line.id, quantity); editing = null }) { Text("Salva") } },
            dismissButton = { TextButton({ model.removeFromTray(line.id); editing = null }) { Text("Rimuovi", color = CR.Accent) } },
        )
    }
}

@Composable
private fun CandidatePicker(matches: List<Match>, onPick: (Match) -> Unit, onDismiss: () -> Unit, modifier: Modifier) {
    Card(
        modifier.fillMaxWidth().padding(10.dp),
        colors = CardDefaults.cardColors(containerColor = CR.Surface),
        border = BorderStroke(1.dp, CR.Line),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Quale carta è?", color = CR.Text, fontWeight = FontWeight.Bold)
            matches.forEach { match ->
                Row(Modifier.fillMaxWidth().clickable { onPick(match) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AsyncImage(match.record.imageUrl, null, Modifier.size(40.dp, 56.dp).clip(RoundedCornerShape(4.dp)).background(CR.Background), contentScale = ContentScale.Crop)
                    Column(Modifier.weight(1f)) {
                        Text(match.record.name, color = CR.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(match.record.set, match.record.number?.let { "#$it" }).joinToString(" · "), color = CR.Muted, fontSize = 12.sp, maxLines = 1)
                    }
                    Text("${(match.score * 100).toInt()}%", color = CR.Muted)
                }
            }
            TextButton(onDismiss, Modifier.align(Alignment.End)) { Text("Ignora", color = CR.Accent) }
        }
    }
}

@Composable
fun StorageDialog(model: AppModel) {
    val settings by model.settings.collectAsState()
    var label by remember { mutableStateOf(settings.storageLabel) }
    var size by remember { mutableStateOf(settings.stackSize?.toString() ?: "") }
    var stack by remember { mutableStateOf(settings.stack.toString()) }
    var start by remember { mutableStateOf(settings.startPosition.toString()) }
    var saving by remember { mutableStateOf(false) }
    val valid = label.isNotBlank() && (size.toIntOrNull() ?: 0) in 1..10_000 &&
        (stack.toIntOrNull() ?: 0) in 1..10_000 && (start.toIntOrNull() ?: 0) in 1..10_000
    AlertDialog(
        onDismissRequest = model::dismissStorage,
        title = { Text("Posizione delle carte") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Dove metti le carte scansionate: Card Rails assegna box, pila e posizione.", color = CR.Muted, fontSize = 13.sp)
                OutlinedTextField(label, { label = it }, label = { Text("Box / etichetta") }, singleLine = true)
                OutlinedTextField(size, { size = it.filter(Char::isDigit) }, label = { Text("Carte per pila") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(stack, { stack = it.filter(Char::isDigit) }, Modifier.weight(1f), label = { Text("Pila") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    OutlinedTextField(start, { start = it.filter(Char::isDigit) }, Modifier.weight(1f), label = { Text("Posizione") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                }
            }
        },
        confirmButton = {
            TextButton({
                saving = true
                model.saveStorage(label, size.toInt(), stack.toInt(), start.toInt()) { saving = false }
            }, enabled = valid && !saving) { Text("Salva") }
        },
        dismissButton = { TextButton(model::dismissStorage) { Text("Annulla") } },
    )
}
