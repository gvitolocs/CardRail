package com.pokoin.cardrails.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pokoin.cardrails.R
import com.pokoin.cardrails.state.AppModel

@Composable
fun LoginScreen(model: AppModel) {
    var signup by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val passwordFocus = remember { FocusRequester() }
    val canSubmit = email.isNotBlank() && password.length >= 8 && !busy

    fun submit() {
        if (!canSubmit) return
        busy = true; error = null; focus.clearFocus()
        model.authenticate(email.trim(), password, signup) { failure -> busy = false; error = failure }
    }

    Column(
        Modifier.fillMaxSize().background(CR.Background).verticalScroll(rememberScrollState()).imePadding().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(48.dp))
        Image(painterResource(R.drawable.cardrails_icon), null, Modifier.size(96.dp).clip(RoundedCornerShape(22.dp)))
        Text("Card Rails", style = CR.Title.copy(fontSize = 34.sp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("Accedi", !signup) { signup = false; error = null }
            Chip("Registrati", signup) { signup = true; error = null }
        }
        OutlinedTextField(
            email, { email = it }, Modifier.fillMaxWidth(), label = { Text("Email") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
        )
        OutlinedTextField(
            password, { password = it }, Modifier.fillMaxWidth().focusRequester(passwordFocus),
            label = { Text("Password (min. 8 caratteri)") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { submit() }),
        )
        if (busy) CircularProgressIndicator(color = CR.Accent)
        else PrimaryButton(if (signup) "Crea account" else "Accedi", ::submit, Modifier.fillMaxWidth(), enabled = canSubmit)
        error?.let { Text(it, color = CR.Accent, textAlign = TextAlign.Center) }
    }
}
