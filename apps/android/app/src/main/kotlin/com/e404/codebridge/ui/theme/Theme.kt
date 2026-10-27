package com.e404.codebridge.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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

/**
 * A fixed brand palette, not the wallpaper's dynamic colour: colour must mean one thing here (blue = the primary
 * action and the selected tab, green = local, violet = cloud). Contrast figures are against the surface they sit on.
 *   dark:  text #F2F6FC on #131C2E 15.5:1, secondary #B4C0D4 on #131C2E 9.3:1
 *   light: text #0F1A2E on #FFFFFF 17.4:1, secondary #4A5873 on #FFFFFF 7.2:1
 *   action: white on #2F6FEB 4.6:1
 */
val Action = Color(0xFF2F6FEB)

private val DarkScheme = darkColorScheme(
    // Dark: a light blue (#8DB4FF, 8.4:1 on #0B1220) so text buttons and links read; filled glass buttons use Action.
    primary = Color(0xFF8DB4FF), onPrimary = Color(0xFF0B1A3A),
    primaryContainer = Color(0xFF1F3A73), onPrimaryContainer = Color(0xFFDCE7FF),
    secondaryContainer = Color(0xFF22304F), onSecondaryContainer = Color(0xFFDCE7FF),
    background = Color(0xFF0B1220), onBackground = Color(0xFFF2F6FC),
    surface = Color(0xFF131C2E), onSurface = Color(0xFFF2F6FC),
    surfaceVariant = Color(0xFF1B2640), onSurfaceVariant = Color(0xFFB4C0D4),
    surfaceContainer = Color(0xFF131C2E), surfaceContainerHigh = Color(0xFF18233A), surfaceContainerHighest = Color(0xFF1E2A45),
    outline = Color(0xFF7C8AA6), outlineVariant = Color(0xFF2B3957),
    error = Color(0xFFFF6B6B),
)

private val LightScheme = lightColorScheme(
    // Light: #1F5BD1 (5.9:1 on #EEF3FB) for links; white on it 6.3:1.
    primary = Color(0xFF1F5BD1), onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE7FF), onPrimaryContainer = Color(0xFF0B2A66),
    secondaryContainer = Color(0xFFE3EAF8), onSecondaryContainer = Color(0xFF14233F),
    background = Color(0xFFEEF3FB), onBackground = Color(0xFF0F1A2E),
    surface = Color(0xFFFFFFFF), onSurface = Color(0xFF0F1A2E),
    surfaceVariant = Color(0xFFE6ECF7), onSurfaceVariant = Color(0xFF4A5873),
    surfaceContainer = Color(0xFFFFFFFF), surfaceContainerHigh = Color(0xFFF6F8FD), surfaceContainerHighest = Color(0xFFEDF1F9),
    outline = Color(0xFF66738F), outlineVariant = Color(0xFFD5DDED),
    error = Color(0xFFC62828),
)

/** Large title, a 17 sp body (the iOS default) and nothing below 12 sp. Everything is in sp so it follows the system font size. */
private val AppTypography = Typography(
    displaySmall = TextStyle(fontSize = 36.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold),
    headlineLarge = TextStyle(fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 25.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun CodeBridgeTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalCodeBridgeColors provides if (darkTheme) DarkSemantic else LightSemantic) {
        MaterialTheme(colorScheme = if (darkTheme) DarkScheme else LightScheme, typography = AppTypography, content = content)
    }
}

object CodeBridgeTheme {
    val colors: CodeBridgeColors @Composable get() = LocalCodeBridgeColors.current
}
