package com.pokoin.cardrails.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pokoin.cardrails.BuildConfig
import com.pokoin.cardrails.engine.CatalogEntry
import com.pokoin.cardrails.engine.Games
import com.pokoin.cardrails.state.AppModel
import com.pokoin.cardrails.state.CatalogStatus

@Composable
fun AccountScreen(model: AppModel) {
    val account by model.account.collectAsState()
    val settings by model.settings.collectAsState()
    val index by model.catalogIndex.collectAsState()
    val status by model.catalogStatus.collectAsState()
    val needsStorage by model.needsStorage.collectAsState()
    var version by remember { mutableIntStateOf(0) }  // bump to re-read download state

    LazyColumn(Modifier.fillMaxSize().background(CR.Background).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Text("Account", style = CR.Title, modifier = Modifier.padding(top = 14.dp))
            Text(account?.email ?: "—", color = CR.Text, fontSize = 16.sp)
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Posizione", color = CR.Text, fontWeight = FontWeight.SemiBold)
                    Text(
                        if (settings.locationConfigured) "Box ${settings.storageLabel} · ${settings.stackSize} carte per pila · pila ${settings.stack}, posizione ${settings.startPosition}"
                        else "Non impostata", color = CR.Muted, fontSize = 13.sp,
                    )
                }
                TextButton(model::requestStorage) { Text("Modifica", color = CR.Accent) }
            }
        }
        item {
            Text("Riconoscimento", color = CR.Text, fontWeight = FontWeight.SemiBold)
            Text(
                when (val s = status) {
                    is CatalogStatus.OnDevice -> "Sul telefono (GPU)"
                    is CatalogStatus.Server -> "Server nezopt — ${s.reason}"
                    else -> "In preparazione"
                },
                color = CR.Muted, fontSize = 13.sp,
            )
        }
        item { Text("Cataloghi", color = CR.Text, fontWeight = FontWeight.SemiBold) }
        items(index?.catalogs.orEmpty(), key = { it.id }) { entry -> CatalogRow(entry, model, version) { version++ } }
        item {
            HorizontalDivider(color = CR.Line)
            PrimaryButton("Esci", model::signOut, Modifier.fillMaxWidth().padding(top = 12.dp))
            Text("Card Rails ${BuildConfig.VERSION_NAME}", color = CR.Muted, fontSize = 12.sp, modifier = Modifier.padding(vertical = 16.dp))
        }
    }
    if (needsStorage) StorageDialog(model)
}

@Composable
private fun CatalogRow(entry: CatalogEntry, model: AppModel, version: Int, changed: () -> Unit) {
    var downloaded by remember(entry.id, version) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(entry.id, version) { downloaded = model.isDownloaded(entry) }
    val languages = if ("*" in entry.languages) "tutte le lingue" else entry.languages.joinToString(" ")
    val mb = (entry.embeddings.bytes + entry.cards.bytes) / 1_000_000.0
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("${Games.name(entry.game)} · $languages", color = CR.Text)
            Text("${"%,d".format(entry.count).replace(',', '.')} carte · ${"%.1f".format(mb)} MB", color = CR.Muted, fontSize = 12.sp)
        }
        when {
            busy -> Text("Scarico…", color = CR.Muted)
            downloaded -> TextButton({ model.deleteCatalog(entry); changed() }) { Text("Elimina", color = CR.Muted) }
            else -> TextButton({ busy = true; model.downloadCatalog(entry) { busy = false; changed() } }) { Text("Scarica", color = CR.Accent) }
        }
    }
}
