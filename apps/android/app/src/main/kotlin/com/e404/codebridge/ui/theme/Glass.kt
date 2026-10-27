package com.e404.codebridge.ui.theme

import android.os.Build
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect
import dev.chrisbanes.haze.hazeSource

/**
 * Two layers, as in Apple's Liquid Glass model: a CONTENT layer (this gradient, solid cards, text) and a FUNCTIONAL
 * layer of floating controls (tab bar, toolbar buttons, primary buttons) that is glass. Glass is never used on
 * content cards. Android has no system glass material, so it is built from a real backdrop blur (Haze, Android 12+),
 * a translucent fill, a one-pixel highlight and a soft sheen. Without blur (Android 11 and older) the fill becomes
 * mostly opaque, so it stays legible instead of looking broken.
 */
val LocalHaze = compositionLocalOf<HazeState?> { null }

private val blurAvailable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

@Immutable
private data class GlassTokens(val fill: Color, val tint: Color, val border: Color, val sheen: Color)

@Composable
private fun glassTokens(prominent: Boolean): GlassTokens {
    val dark = isSystemInDarkTheme()
    if (prominent) {
        val action = Action
        return GlassTokens(fill = action.copy(alpha = if (blurAvailable) 0.86f else 1f), tint = action, border = Color.White.copy(alpha = 0.35f), sheen = Color.White.copy(alpha = 0.22f))
    }
    return if (dark) {
        GlassTokens(Color.White.copy(alpha = if (blurAvailable) 0.12f else 0.18f), Color.White.copy(alpha = 0.06f), Color.White.copy(alpha = 0.26f), Color.White.copy(alpha = 0.14f))
    } else {
        GlassTokens(Color.White.copy(alpha = if (blurAvailable) 0.55f else 0.92f), Color.White.copy(alpha = 0.35f), Color.White.copy(alpha = 0.85f), Color.White.copy(alpha = 0.6f))
    }
}

/** A glass surface: blur of whatever scrolls beneath it, a translucent fill, a hairline edge and a top sheen. */
@Composable
fun Modifier.glass(shape: Shape, prominent: Boolean = false): Modifier {
    val t = glassTokens(prominent)
    val haze = LocalHaze.current
    val shaped = this.clip(shape) // the blur, fill and sheen must all follow the shape, never a rectangle
    val blurred = if (haze != null && blurAvailable) {
        shaped.hazeEffect(haze, style = HazeStyle(backgroundColor = Color.Transparent, tint = HazeTint(t.tint), blurRadius = 26.dp, noiseFactor = 0f))
    } else shaped
    return blurred
        .background(t.fill, shape)
        .drawBehind { drawRect(Brush.verticalGradient(listOf(t.sheen, Color.Transparent), endY = size.height * 0.55f)) }
        .border(BorderStroke(1.dp, Brush.verticalGradient(listOf(t.border, t.border.copy(alpha = t.border.alpha * 0.35f)))), shape)
}

/**
 * The content layer behind every screen: a quiet gradient with a soft green glow (local) and violet glow (cloud),
 * which is what the glass above it picks up and refracts. It is also the blur source for the glass.
 */
@Composable
fun GradientBackground(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val base = MaterialTheme.colorScheme.background
    val colors = CodeBridgeTheme.colors
    val haze = LocalHaze.current
    Box(
        modifier
            .fillMaxSize()
            .background(base)
            .drawBehind {
                val w = size.width
                val h = size.height
                drawRect(Brush.radialGradient(listOf(colors.local.copy(alpha = if (dark) 0.34f else 0.22f), Color.Transparent), center = Offset(0f, h * 0.18f), radius = w * 1.1f))
                drawRect(Brush.radialGradient(listOf(colors.cloud.copy(alpha = if (dark) 0.34f else 0.20f), Color.Transparent), center = Offset(w, h * 0.38f), radius = w * 1.15f))
                drawRect(Brush.radialGradient(listOf(Color(0xFF2F6FEB).copy(alpha = if (dark) 0.28f else 0.14f), Color.Transparent), center = Offset(w * 0.35f, h * 0.95f), radius = w * 1.2f))
            }
            .then(if (haze != null) Modifier.hazeSource(haze) else Modifier),
    ) {
        // Text outside a Material surface would default to black: on the dark gradient that is ~1:1.
        CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onBackground) { content() }
    }
}

/** A pill button on the functional layer. [prominent] is the one filled, tinted primary action of a screen. */
@Composable
fun GlassButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    prominent: Boolean = false,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(percent = 50)
    val content = if (prominent) Color.White else MaterialTheme.colorScheme.onSurface
    Box(
        modifier
            .heightIn(min = 56.dp)
            .glass(shape, prominent)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = content.copy(alpha = if (enabled) 1f else 0.5f))
    }
}

/** A round glass button for toolbars (back, add). Always 48 dp, with a spoken label. */
@Composable
fun GlassIconButton(description: String, onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier
            .size(48.dp)
            .glass(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** A glass capsule that holds a row of controls, like the floating tab bar. */
@Composable
fun GlassCapsule(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(percent = 50)
    Row(
        modifier.glass(shape).padding(horizontal = 8.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { content() }
}
