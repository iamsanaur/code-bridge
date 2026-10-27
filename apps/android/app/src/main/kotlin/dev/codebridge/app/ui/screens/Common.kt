package dev.codebridge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController

/** Standard screen: top app bar (with back when [nav] can go back) and a scrolling column. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(
    title: String,
    nav: NavController?,
    actions: @Composable () -> Unit = {},
    scroll: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (nav?.previousBackStackEntry != null) {
                        IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                    }
                },
                actions = { actions() },
            )
        },
    ) { padding ->
        val base = Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 16.dp)
        Column(
            modifier = if (scroll) base.verticalScroll(rememberScrollState()) else base,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}
