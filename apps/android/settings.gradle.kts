pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
    }
    plugins {
        id("com.android.application") version "8.13.0"
        id("org.jetbrains.kotlin.jvm") version "2.2.20"
        id("org.jetbrains.kotlin.android") version "2.2.20"
        id("org.jetbrains.kotlin.plugin.compose") version "2.2.20"
        id("org.jetbrains.kotlin.plugin.serialization") version "2.2.20"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
    }
}

rootProject.name = "codebridge-android"

// :core is plain Kotlin/JVM (protocol, networking, state) and builds anywhere.
// Set CODEBRIDGE_JVM_ONLY=1 to build/test it without the Android SDK.
include(":core")
if (providers.environmentVariable("CODEBRIDGE_JVM_ONLY").orNull != "1") {
    include(":app")
}
