package com.pokoin.cardrails.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Card Rails web colors. */
object CR {
    val Background = Color(0xFF0D0D0F)
    val Header = Color(0xFF111111)
    val Surface = Color(0xFF17171A)
    val Line = Color(0xFF2A2A2E)
    val Accent = Color(0xFFEE1515)
    val Success = Color(0xFF22C55E)
    val Text = Color.White
    val Muted = Color(0xFF9A9A9F)

    /** Condensed bold titles, like Barlow Condensed on the web. */
    val Title = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 26.sp, letterSpacing = (-0.3).sp, color = Text)
}

@Composable
fun CardRailsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = CR.Accent, onPrimary = Color.White, secondary = CR.Accent,
            background = CR.Background, onBackground = CR.Text,
            surface = CR.Surface, onSurface = CR.Text, surfaceVariant = CR.Surface,
            onSurfaceVariant = CR.Muted, outline = CR.Line, error = CR.Accent,
        ),
        content = content,
    )
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick, modifier, enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = CR.Accent, disabledContainerColor = CR.Accent.copy(alpha = .4f)),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 14.dp),
    ) { Text(text, fontWeight = FontWeight.SemiBold) }
}

@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit) {
    OutlinedButton(
        onClick,
        border = BorderStroke(1.dp, if (selected) CR.Accent else CR.Line),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = if (selected) CR.Accent else CR.Surface, contentColor = CR.Text),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
    ) { Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
}

fun euro(value: Double): String = "€" + String.format(java.util.Locale.ITALY, "%.2f", value)
