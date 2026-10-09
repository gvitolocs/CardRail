package com.pokoin.cardrails.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.pokoin.cardrails.state.AppModel

@Composable
fun CardRailsApp(model: AppModel) {
    val signedIn by model.signedIn.collectAsState()
    val offline by model.offline.collectAsState()
    val message by model.message.collectAsState()
    val snackbar = remember { SnackbarHostState() }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.onResume() }
    LaunchedEffect(message) {
        message?.let { snackbar.showSnackbar(it); model.clearMessage() }
    }

    Box(Modifier.fillMaxSize().background(CR.Background).statusBarsPadding()) {
        if (signedIn) MainTabs(model, snackbar) else LoginScreen(model)
        if (signedIn && offline) {
            Text(
                "Sei offline — le carte restano in coda",
                color = CR.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth().background(CR.Accent).padding(6.dp),
            )
        }
    }
}

@Composable
private fun MainTabs(model: AppModel, snackbar: SnackbarHostState) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val count by model.items.collectAsState()
    Scaffold(
        containerColor = CR.Background,
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar(containerColor = CR.Header) {
                val colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = CR.Accent, selectedTextColor = CR.Accent, indicatorColor = CR.Surface,
                    unselectedIconColor = CR.Muted, unselectedTextColor = CR.Muted,
                )
                NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Filled.Search, null) }, label = { Text("Scansiona") }, colors = colors)
                NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Filled.Menu, null) }, label = { Text("Inventario (${count.size})") }, colors = colors)
                NavigationBarItem(tab == 2, { tab = 2 }, { Icon(Icons.Filled.Person, null) }, label = { Text("Account") }, colors = colors)
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                0 -> ScanScreen(model)
                1 -> InventoryScreen(model)
                else -> AccountScreen(model)
            }
        }
    }
}
