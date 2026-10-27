package com.e404.codebridge.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import com.e404.codebridge.ui.theme.GlassIconButton
import com.e404.codebridge.ui.theme.GradientBackground
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController

/** Space the floating tab bar needs at the bottom of scrolling content, so nothing is trapped under it. */
val LocalBottomInset = androidx.compose.runtime.compositionLocalOf { 24.dp }

/**
 * Standard screen: a gradient content layer, a large title with an optional glass back button, and a scrolling
 * column. Scrolling content passes beneath the floating tab bar and is blurred by it.
 */
@Composable
fun ScreenScaffold(
    title: String,
    nav: NavController?,
    actions: @Composable () -> Unit = {},
    scroll: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    GradientBackground {
        Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (nav?.previousBackStackEntry != null) {
                    GlassIconButton("Back", onClick = { nav.popBackStack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface)
                    }
                }
                Text(title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.weight(1f).semantics { heading() })
                actions()
            }
            val body = Modifier.fillMaxSize().padding(horizontal = 20.dp)
            Column(
                modifier = if (scroll) body.verticalScroll(rememberScrollState()) else body,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                content()
                Spacer(Modifier.height(LocalBottomInset.current))
            }
        }
    }
}
