package com.e404.codebridge.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.e404.codebridge.ui.theme.Action
import com.e404.codebridge.ui.theme.GlassCapsule

data class TabItem(val route: String, val label: String, val icon: ImageVector)

/**
 * The signature element: a capsule of glass that floats above the content, which scrolls (and blurs) beneath it.
 * Tabs navigate, they don't act. Labels are always shown. Colour is spent only on the selected tab.
 */
@Composable
fun FloatingTabBar(tabs: List<TabItem>, currentRoute: String?, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    GlassCapsule(modifier) {
        tabs.forEach { tab ->
            val selected = currentRoute == tab.route
            val pill = RoundedCornerShape(percent = 50)
            Column(
                Modifier
                    .defaultMinSize(minWidth = 68.dp, minHeight = 56.dp)
                    .background(if (selected) Action else Color.Transparent, pill)
                    .clickable(role = Role.Tab) { onSelect(tab.route) }
                    .semantics { this.selected = selected }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                val tint = if (selected) Color.White else MaterialTheme.colorScheme.onSurface
                Icon(tab.icon, contentDescription = null, tint = tint)
                Text(tab.label, style = MaterialTheme.typography.labelSmall, color = tint)
            }
        }
    }
}
