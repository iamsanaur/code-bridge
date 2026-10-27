plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Compiled with whatever JDK runs Gradle (17+), emitting Java 17 bytecode for Android.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    api(libs.okhttp)
    testImplementation(kotlin("test"))
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    useJUnitPlatform()
    // Integration tests against a running API are opt-in (see LiveApiTest).
    environment("CODEBRIDGE_IT_API_URL", System.getenv("CODEBRIDGE_IT_API_URL") ?: "")
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
