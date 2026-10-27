package dev.codebridge.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp

/** Colours that carry meaning and must stay consistent regardless of dynamic colour. */
@Immutable
data class CodeBridgeColors(
    val local: Color,
    val cloud: Color,
    val success: Color,
    val warning: Color,
    val danger: Color,
    val terminalBackground: Color,
    val terminalText: Color,
    val ansi: List<Color>,
)

private val Ansi = listOf(
    0xFF1E2430, 0xFFFF6B6B, 0xFF4FD1A5, 0xFFF5C451, 0xFF5B9CFF, 0xFFC792EA, 0xFF56D4E0, 0xFFC8CDD8,
    0xFF5C6577, 0xFFFF8A8A, 0xFF7BE3BE, 0xFFFFD97A, 0xFF8AB8FF, 0xFFDDB3FF, 0xFF8BE9F2, 0xFFFFFFFF,
).map { Color(it) }

private val DarkSemantic = CodeBridgeColors(
    local = Color(0xFF4FD1A5), cloud = Color(0xFFB48CFF), success = Color(0xFF4FD1A5), warning = Color(0xFFF5C451),
    danger = Color(0xFFFF6B6B), terminalBackground = Color(0xFF05070B), terminalText = Color(0xFFD6DBE5), ansi = Ansi,
)
private val LightSemantic = DarkSemantic.copy(
    local = Color(0xFF0E8A63), cloud = Color(0xFF7C4DDB), success = Color(0xFF0E8A63), warning = Color(0xFFA36A00), danger = Color(0xFFC62828),
)

val LocalCodeBridgeColors = staticCompositionLocalOf { DarkSemantic }

val Mono = FontFamily.Monospace
val TerminalTextStyle = TextStyle(fontFamily = Mono, fontSize = 12.5.sp, lineHeight = 17.sp)

@Composable
fun CodeBridgeTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val context = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        darkTheme -> darkColorScheme(primary = Color(0xFF5B9CFF), background = Color(0xFF0B0E14), surface = Color(0xFF131823))
        else -> lightColorScheme(primary = Color(0xFF2F6FDB))
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalCodeBridgeColors provides if (darkTheme) DarkSemantic else LightSemantic) {
        MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
    }
}

object CodeBridgeTheme {
    val colors: CodeBridgeColors @Composable get() = LocalCodeBridgeColors.current
}
