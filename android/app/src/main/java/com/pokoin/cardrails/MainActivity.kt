package com.pokoin.cardrails

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.pokoin.cardrails.state.AppModel
import com.pokoin.cardrails.ui.CardRailsApp
import com.pokoin.cardrails.ui.CardRailsTheme

class MainActivity : ComponentActivity() {
    private val model: AppModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CardRailsTheme { CardRailsApp(model) } }
    }
}
