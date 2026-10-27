package dev.codebridge.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.codebridge.app.AppContainer
import dev.codebridge.app.ui.components.ConnectionBanner
import dev.codebridge.app.ui.components.Loading
import dev.codebridge.app.ui.screens.ChangesScreen
import dev.codebridge.app.ui.screens.CloudScreen
import dev.codebridge.app.ui.screens.CredentialsScreen
import dev.codebridge.app.ui.screens.DeviceScreen
import dev.codebridge.app.ui.screens.DevicesScreen
import dev.codebridge.app.ui.screens.HomeScreen
import dev.codebridge.app.ui.screens.NewCloudSessionScreen
import dev.codebridge.app.ui.screens.NewSessionScreen
import dev.codebridge.app.ui.screens.PairScreen
import dev.codebridge.app.ui.screens.RegisterScreen
import dev.codebridge.app.ui.screens.SessionScreen
import dev.codebridge.app.ui.screens.SessionsScreen
import dev.codebridge.app.ui.screens.SettingsScreen
import dev.codebridge.app.ui.screens.SignInScreen
import dev.codebridge.app.ui.screens.UsageScreen
import dev.codebridge.app.ui.screens.WelcomeScreen

object Routes {
    const val WELCOME = "welcome"
    const val SIGN_IN = "sign-in"
    const val REGISTER = "register"
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
fun CodeBridgeApp(container: AppContainer, pendingPairCode: String?, onPairCodeConsumed: () -> Unit) {
    val auth = remember { AuthState(container) }
    LaunchedEffect(Unit) {
        container.api.onSignedOut = { auth.signedOutLocally() }
        auth.restore()
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
        val connection by container.realtime.status.collectAsStateWithLifecycle()
        val backStack by nav.currentBackStackEntryAsState()
        val currentRoute = backStack?.destination?.route
        val showTabs = user != null && Tabs.any { it.route == currentRoute }

        Scaffold(
            bottomBar = {
                if (showTabs) {
                    NavigationBar {
                        Tabs.forEach { tab ->
                            NavigationBarItem(
                                selected = currentRoute == tab.route,
                                onClick = { nav.switchTab(tab.route) },
                                icon = { Icon(tab.icon, contentDescription = null) },
                                label = { Text(tab.label) },
                            )
                        }
                    }
                }
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                if (user != null) ConnectionBanner(connection)
                NavHost(nav, startDestination = start, modifier = Modifier.weight(1f)) {
                    composable(Routes.WELCOME) { WelcomeScreen(nav) }
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
            }
        }
    }
}

fun NavHostController.switchTab(route: String) = navigate(route) {
    popUpTo(graph.findStartDestination().id) { saveState = true }
    launchSingleTop = true
    restoreState = true
}
