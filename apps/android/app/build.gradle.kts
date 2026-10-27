plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release builds must point at an HTTPS server: ./gradlew assembleRelease -Pcodebridge.apiUrl=https://…
val releaseApiUrl = providers.gradleProperty("codebridge.apiUrl").orElse("https://codebridge.example.com").get()
require(releaseApiUrl.startsWith("https://")) { "codebridge.apiUrl must use https://" }

android {
    namespace = "dev.codebridge.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.codebridge.app"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            // The emulator reaches the host's localhost at 10.0.2.2. Override with -Pcodebridge.debugApiUrl=…
            buildConfigField("String", "API_URL", "\"${providers.gradleProperty("codebridge.debugApiUrl").orElse("http://10.0.2.2:8080").get()}\"")
        }
        release {
            buildConfigField("String", "API_URL", "\"$releaseApiUrl\"")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation(project(":core"))
    implementation(libs.coroutines.android)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.navigation.compose)
    implementation(libs.code.scanner)

    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)
    testImplementation(kotlin("test"))
}
