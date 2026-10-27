package dev.codebridge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import dev.codebridge.app.ui.AuthState
import dev.codebridge.app.ui.LocalContainer
import dev.codebridge.app.ui.Routes
import dev.codebridge.app.ui.components.Notice
import dev.codebridge.app.ui.components.NoticeTone
import dev.codebridge.app.ui.rememberAction

@Composable
fun WelcomeScreen(nav: NavController) {
    val container = LocalContainer.current
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(64.dp))
        Text("CodeBridge", fontSize = 34.sp, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
        Text(
            "Run and supervise coding sessions on your own Mac from anywhere. Commands execute on your Mac, inside folders you approve on the Mac. " +
                "Optional cloud sessions run in an isolated Anthropic-hosted sandbox and are always labelled as such.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = { nav.navigate(Routes.SIGN_IN) }, modifier = Modifier.fillMaxWidth()) { Text("Sign in") }
        OutlinedButton(onClick = { nav.navigate(Routes.REGISTER) }, modifier = Modifier.fillMaxWidth()) { Text("Create an account") }
        if (container.isInsecure) Notice("The server (${container.apiUrl}) is not using HTTPS. Only use this for local development.", NoticeTone.WARNING)
        Text("Server: ${container.apiUrl}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
    }
}

@Composable
private fun CredentialsForm(title: String, submitLabel: String, minPassword: Int, nav: NavController, submit: suspend (String, String) -> Unit) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val action = rememberAction()
    ScreenScaffold(title, nav) {
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
            onClick = { action.run { submit(email.trim(), password) } },
            enabled = !action.busy && email.isNotBlank() && password.length >= minPassword,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (action.busy) "Please wait…" else submitLabel) }
    }
}

@Composable
fun SignInScreen(nav: NavController, auth: AuthState) = CredentialsForm("Sign in", "Sign in", 1, nav) { e, p -> auth.signIn(e, p) }

@Composable
fun RegisterScreen(nav: NavController, auth: AuthState) = CredentialsForm("Create account", "Create account", 12, nav) { e, p -> auth.register(e, p) }
