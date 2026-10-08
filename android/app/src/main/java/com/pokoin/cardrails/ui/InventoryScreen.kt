package com.pokoin.cardrails.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.pokoin.cardrails.api.InventoryItem
import com.pokoin.cardrails.api.ItemPatch
import com.pokoin.cardrails.engine.Conditions
import com.pokoin.cardrails.state.AppModel
import kotlinx.coroutines.launch

fun locationCode(item: InventoryItem): String? =
    item.location?.box?.let { box -> "B$box-R${item.location.row ?: "?"}-${item.location.position ?: "?"}" }

@Composable
fun InventoryScreen(model: AppModel) {
    val items by model.items.collectAsState()
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<InventoryItem?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val shown = items.filter { item ->
        query.isBlank() || listOf(item.identity.name, item.identity.setName, item.identity.number, locationCode(item).orEmpty())
            .any { it.contains(query.trim(), ignoreCase = true) }
    }

    Column(Modifier.fillMaxSize().background(CR.Background).padding(horizontal = 14.dp)) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Inventario", style = CR.Title, modifier = Modifier.weight(1f))
            TextButton({ scope.launch { refreshing = true; model.refreshInventory(); refreshing = false } }, enabled = !refreshing) {
                Text(if (refreshing) "Aggiorno…" else "Aggiorna", color = CR.Accent)
            }
        }
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Cerca nome, set, numero, posizione") }, singleLine = true)
        if (shown.isEmpty()) {
            Text(if (items.isEmpty()) "Nessuna carta. Scansiona la prima!" else "Nessun risultato", color = CR.Muted, modifier = Modifier.padding(24.dp))
        }
        LazyColumn {
            items(shown, key = { it.id }) { item ->
                Row(Modifier.fillMaxWidth().clickable { editing = item }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AsyncImage(item.art, null, Modifier.size(44.dp, 62.dp).clip(RoundedCornerShape(5.dp)).background(CR.Surface), contentScale = ContentScale.Crop)
                    Column(Modifier.weight(1f)) {
                        Text(item.identity.name, color = CR.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${item.identity.setName} · #${item.identity.number}", color = CR.Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(item.language, item.condition, item.printing, locationCode(item)).joinToString(" · "), color = CR.Muted, fontSize = 12.sp)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text("×${item.quantity}", color = CR.Text, fontWeight = FontWeight.Bold)
                        Text(euro(item.price), color = CR.Muted, fontSize = 12.sp)
                    }
                }
                HorizontalDivider(color = CR.Line)
            }
        }
    }
    editing?.let { item -> ItemEditDialog(item, model) { editing = null } }
}

@Composable
private fun ItemEditDialog(item: InventoryItem, model: AppModel, close: () -> Unit) {
    var quantity by remember { mutableStateOf(item.quantity) }
    var price by remember { mutableStateOf(String.format(java.util.Locale.ITALY, "%.2f", item.price)) }
    var condition by remember { mutableStateOf(item.condition) }
    var confirmDelete by remember { mutableStateOf(false) }
    val parsedPrice = price.replace(',', '.').toDoubleOrNull()

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Eliminare ${item.identity.name}?") },
            text = { Text("La carta viene tolta dall'inventario.", color = CR.Muted) },
            confirmButton = { TextButton({ model.delete(item); close() }) { Text("Elimina", color = CR.Accent) } },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("Annulla") } },
        )
        return
    }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(item.identity.name) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("${item.identity.setName} · #${item.identity.number}", color = CR.Muted)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Chip("−", false) { if (quantity > 0) quantity-- }
                    Text("$quantity", color = CR.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Chip("+", false) { quantity++ }
                }
                OutlinedTextField(price, { price = it }, label = { Text("Prezzo €") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { Conditions.all.forEach { Chip(it, it == condition) { condition = it } } }
            }
        },
        confirmButton = {
            TextButton({
                model.patch(item, ItemPatch(version = item.version, quantity = quantity, price = parsedPrice, condition = condition))
                close()
            }, enabled = parsedPrice != null && parsedPrice >= 0) { Text("Salva") }
        },
        dismissButton = { TextButton({ confirmDelete = true }) { Text("Elimina", color = CR.Accent) } },
    )
}
