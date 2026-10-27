package com.e404.codebridge.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material3.Icon
import com.e404.codebridge.ui.theme.GlassButton
import com.e404.codebridge.ui.theme.GradientBackground
import com.e404.codebridge.ui.theme.glass
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.e404.codebridge.ui.AuthState
import com.e404.codebridge.ui.LocalContainer
import com.e404.codebridge.ui.Routes
import com.e404.codebridge.ui.components.Notice
import com.e404.codebridge.ui.components.NoticeTone
import com.e404.codebridge.ui.rememberAction
import dev.codebridge.core.parseConnectLink

/** No account and no sign-in: scan the QR code your relay shows, or paste its link. */
@Composable
fun WelcomeScreen(nav: NavController, auth: AuthState) {
    val container = LocalContainer.current
    val context = LocalContext.current
    var pasting by remember { mutableStateOf(false) }
    var pasted by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val accept = { text: String ->
        error = null
        val link = parseConnectLink(text)
        if (link != null) auth.pendingConnect = link
        else error = "That isn’t a CodeBridge connect link. Run `codebridge-relay link` to show it again."
    }
    GradientBackground {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(56.dp))
            // The one signature mark: the bridge glyph on a glass tile, the first thing on screen.
            Box(Modifier.size(84.dp).glass(RoundedCornerShape(26.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Hub, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(44.dp))
            }
            Text("CodeBridge", style = MaterialTheme.typography.displaySmall, modifier = Modifier.semantics { heading() })
            Text(
                "Run coding sessions on your own Mac or PC, from anywhere. No account: scan your relay’s QR code and you’re connected.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.weight(1f, fill = false).height(24.dp))
            GlassButton("Scan QR code", onClick = { scanQrPayload(context, accept) { error = it } }, prominent = true, modifier = Modifier.fillMaxWidth())
            GlassButton("Paste a link", onClick = { pasting = true }, modifier = Modifier.fillMaxWidth())
            GlassButton("Set up a relay", onClick = { nav.navigate(Routes.SETUP) }, modifier = Modifier.fillMaxWidth())
            error?.let { Notice(it, NoticeTone.DANGER) }
            TextButton(onClick = { nav.navigate(Routes.SIGN_IN) }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Sign in to a shared relay") }
            if (container.isInsecure) Notice("This build connects to ${container.apiUrl} without HTTPS. Only use this for local development.", NoticeTone.WARNING)
        }
    }
    if (pasting) {
        AlertDialog(
            onDismissRequest = { pasting = false },
            title = { Text("Paste your link") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Run `codebridge-relay link` on the computer that runs your relay to see it.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(value = pasted, onValueChange = { pasted = it }, singleLine = true, placeholder = { Text("codebridge://connect?…") })
                }
            },
            confirmButton = { TextButton(onClick = { pasting = false; accept(pasted); pasted = "" }) { Text("Continue") } },
            dismissButton = { TextButton(onClick = { pasting = false; pasted = "" }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun CredentialsForm(
    title: String,
    submitLabel: String,
    minPassword: Int,
    nav: NavController,
    auth: AuthState,
    submit: suspend (String, String) -> Unit,
) {
    var server by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val action = rememberAction()
    ScreenScaffold(title, nav) {
        OutlinedTextField(
            value = server,
            onValueChange = { server = it },
            label = { Text("Shared relay address") },
            placeholder = { Text("https://relay.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        val tooShort = password.isNotEmpty() && password.length < minPassword
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(if (minPassword > 1) "Password ($minPassword+ characters)" else "Password") },
            singleLine = true,
            isError = tooShort,
            supportingText = { if (tooShort) Text("Use at least $minPassword characters") },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        action.error?.let { Notice(it, NoticeTone.DANGER) }
        Button(
            onClick = { action.run { if (server.isNotBlank()) auth.useSharedRelay(server); submit(email.trim(), password) } },
            enabled = !action.busy && email.isNotBlank() && password.length >= minPassword,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (action.busy) "Please wait…" else submitLabel) }
    }
}

@Composable
fun SignInScreen(nav: NavController, auth: AuthState) = CredentialsForm("Sign in to a shared relay", "Sign in", 1, nav, auth) { e, p -> auth.signIn(e, p) }

@Composable
fun RegisterScreen(nav: NavController, auth: AuthState) = CredentialsForm("Create account", "Create account", 12, nav, auth) { e, p -> auth.register(e, p) }
