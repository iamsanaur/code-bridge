package com.e404.codebridge.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.ui.window.Dialog
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.e404.codebridge.ui.components.FloatingTabBar
import com.e404.codebridge.ui.components.TabItem
import com.e404.codebridge.ui.screens.LocalBottomInset
import com.e404.codebridge.ui.theme.LocalHaze
import dev.chrisbanes.haze.HazeState
import dev.codebridge.core.ConnectionStatus
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.e404.codebridge.AppContainer
import com.e404.codebridge.ui.components.ConnectionBanner
import com.e404.codebridge.ui.components.Loading
import com.e404.codebridge.ui.screens.ChangesScreen
import com.e404.codebridge.ui.screens.CloudScreen
import com.e404.codebridge.ui.screens.CredentialsScreen
import com.e404.codebridge.ui.screens.DeviceScreen
import com.e404.codebridge.ui.screens.DevicesScreen
import com.e404.codebridge.ui.screens.HomeScreen
import com.e404.codebridge.ui.screens.NewCloudSessionScreen
import com.e404.codebridge.ui.screens.NewSessionScreen
import com.e404.codebridge.ui.screens.PairScreen
import com.e404.codebridge.ui.screens.RegisterScreen
import com.e404.codebridge.ui.screens.SessionScreen
import com.e404.codebridge.ui.screens.SessionsScreen
import com.e404.codebridge.ui.screens.SettingsScreen
import com.e404.codebridge.ui.screens.SignInScreen
import com.e404.codebridge.ui.screens.UsageScreen
import com.e404.codebridge.ui.screens.SetupRelayScreen
import com.e404.codebridge.ui.screens.WelcomeScreen
import dev.codebridge.core.ConnectLink
import dev.codebridge.core.parseConnectLink

object Routes {
    const val WELCOME = "welcome"
    const val SIGN_IN = "sign-in"
    const val REGISTER = "register"
    const val SETUP = "setup-relay"
    const val HOME = "home"
    const val SESSIONS = "sessions"
    const val CLOUD = "cloud"
    const val SETTINGS = "settings"
    const val PAIR = "pair?code={code}"
    const val DEVICES = "devices"
    const val DEVICE = "device/{id}"
    const val NEW_SESSION = "new-session/{deviceId}/{workspaceId}"
    const val SESSION = "session/{id}"
    const val CHANGES = "changes/{deviceId}/{workspaceId}"
    const val CREDENTIALS = "credentials"
    const val NEW_CLOUD = "cloud/new"
    const val USAGE = "usage"

    fun pair(code: String? = null) = if (code == null) "pair" else "pair?code=$code"
    fun device(id: String) = "device/$id"
    fun newSession(deviceId: String, workspaceId: String) = "new-session/$deviceId/$workspaceId"
    fun session(id: String) = "session/$id"
    fun changes(deviceId: String, workspaceId: String) = "changes/$deviceId/$workspaceId"
}

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val Tabs = listOf(
    Tab(Routes.HOME, "Home", Icons.Default.Home),
    Tab(Routes.SESSIONS, "Sessions", Icons.Default.Terminal),
    Tab(Routes.CLOUD, "Cloud", Icons.Default.Cloud),
    Tab(Routes.SETTINGS, "Settings", Icons.Default.Settings),
)

@Composable
fun CodeBridgeApp(
    container: AppContainer,
    pendingPairCode: String?,
    onPairCodeConsumed: () -> Unit,
    pendingConnect: ConnectLink?,
    onConnectConsumed: () -> Unit,
) {
    val auth = remember { AuthState(container) }
    LaunchedEffect(Unit) {
        container.onSignedOut = { auth.sessionLost() }
        auth.restore()
    }
    LaunchedEffect(pendingConnect) {
        if (pendingConnect != null) {
            auth.pendingConnect = pendingConnect
            onConnectConsumed()
        }
    }
    CompositionLocalProvider(LocalContainer provides container) {
        if (!auth.ready) {
            Loading("Starting CodeBridge…")
            return@CompositionLocalProvider
        }
        val nav = rememberNavController()
        val user = auth.user
        val start = remember { if (user == null) Routes.WELCOME else Routes.HOME }
        // Signing in or out replaces the whole back stack.
        LaunchedEffect(user == null) {
            val target = if (user == null) Routes.WELCOME else Routes.HOME
            if (nav.currentDestination?.route != target) nav.navigate(target) { popUpTo(nav.graph.id) { inclusive = true } }
        }
        LaunchedEffect(pendingPairCode, user) {
            if (pendingPairCode != null && user != null) {
                nav.navigate(Routes.pair(pendingPairCode))
                onPairCodeConsumed()
            }
        }
        ConfirmConnectDialog(auth)
        val connection by container.realtime.status.collectAsStateWithLifecycle()
        val backStack by nav.currentBackStackEntryAsState()
        val currentRoute = backStack?.destination?.route
        val showTabs = user != null && Tabs.any { it.route == currentRoute }

        val haze = remember { HazeState() }
        CompositionLocalProvider(LocalHaze provides haze, LocalBottomInset provides (if (showTabs) 120.dp else 24.dp)) {
            Box(Modifier.fillMaxSize()) {
                NavHost(nav, startDestination = start, modifier = Modifier.fillMaxSize()) {
                    composable(Routes.WELCOME) { WelcomeScreen(nav, auth) }
                    composable(Routes.SETUP) { SetupRelayScreen(nav) { payload -> parseConnectLink(payload)?.let { auth.pendingConnect = it } } }
                    composable(Routes.SIGN_IN) { SignInScreen(nav, auth) }
                    composable(Routes.REGISTER) { RegisterScreen(nav, auth) }
                    composable(Routes.HOME) { HomeScreen(nav) }
                    composable(Routes.SESSIONS) { SessionsScreen(nav) }
                    composable(Routes.CLOUD) { CloudScreen(nav) }
                    composable(Routes.SETTINGS) { SettingsScreen(nav, auth) }
                    composable(Routes.PAIR) { PairScreen(nav, it.arguments?.getString("code")) }
                    composable(Routes.DEVICES) { DevicesScreen(nav) }
                    composable(Routes.DEVICE) { DeviceScreen(nav, it.arguments!!.getString("id")!!) }
                    composable(Routes.NEW_SESSION) { NewSessionScreen(nav, it.arguments!!.getString("deviceId")!!, it.arguments!!.getString("workspaceId")!!) }
                    composable(Routes.SESSION) { SessionScreen(nav, it.arguments!!.getString("id")!!) }
                    composable(Routes.CHANGES) { ChangesScreen(nav, it.arguments!!.getString("deviceId")!!, it.arguments!!.getString("workspaceId")!!) }
                    composable(Routes.CREDENTIALS) { CredentialsScreen(nav) }
                    composable(Routes.NEW_CLOUD) { NewCloudSessionScreen(nav) }
                    composable(Routes.USAGE) { UsageScreen(nav) }
                }
                if (user != null && connection != ConnectionStatus.CONNECTED) {
                    Box(Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 6.dp)) { ConnectionBanner(connection) }
                }
                if (showTabs) {
                    FloatingTabBar(
                        tabs = Tabs.map { TabItem(it.route, it.label, it.icon) },
                        currentRoute = currentRoute,
                        onSelect = { nav.switchTab(it) },
                        modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 12.dp),
                    )
                }
            }
        }
    }
}

fun NavHostController.switchTab(route: String) = navigate(route) {
    popUpTo(graph.findStartDestination().id) { saveState = true }
    launchSingleTop = true
    restoreState = true
}

/** Asks before joining a relay named by a scanned or opened link, then connects. */
@Composable
private fun ConfirmConnectDialog(auth: AuthState) {
    val link = auth.pendingConnect
    val action = rememberAction()
    if (link != null) {
        AlertDialog(
            onDismissRequest = { auth.pendingConnect = null },
            title = { Text("Connect to ${link.host}?") },
            text = { Text("This relay will be able to run commands on every computer you connect to it. Only continue if you set it up yourself.") },
            confirmButton = { TextButton(onClick = { auth.pendingConnect = null; action.run { auth.connect(link) } }) { Text("Connect") } },
            dismissButton = { TextButton(onClick = { auth.pendingConnect = null }) { Text("Cancel") } },
        )
    }
    if (action.busy) Dialog(onDismissRequest = {}) { Loading("Connecting…") }
    action.error?.let { message ->
        AlertDialog(
            onDismissRequest = { action.error = null },
            title = { Text("Couldn’t connect") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { action.error = null }) { Text("OK") } },
        )
    }
}
