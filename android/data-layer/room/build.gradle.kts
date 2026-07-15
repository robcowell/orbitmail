// Android library module for the Orbit Mail data layer (Room).
//
// NOT built in the spike/verification container: Room + androidx.sqlite live on
// Google's Maven (maven.google.com), which the sandbox proxy blocks, and there
// is no Android SDK here. Build this from the Android app project on a dev
// machine (Android SDK + Google Maven reachable). The SQL contract this Room
// code generates is verified independently by ../schema-verify (runs anywhere).
//
// Wire it into the app's settings.gradle.kts as `:data-layer:room` (or copy the
// package into the app module). Versions below are current stable as of the port.

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "orbit.data"
    compileSdk = 35

    defaultConfig {
        minSdk = 26 // matches the plan's IDLE/foreground-service baseline
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Export the generated schema JSON so migrations can be authored/tested.
    ksp { arg("room.schemaLocation", "$projectDir/schemas") }
}

dependencies {
    val room = "2.7.1"
    implementation("androidx.room:room-runtime:$room")
    implementation("androidx.room:room-ktx:$room") // Flow + suspend query support
    ksp("androidx.room:room-compiler:$room")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.1")

    // Instrumented DAO tests (run on device/emulator) go here when the app exists:
    // androidTestImplementation("androidx.room:room-testing:$room")
    // androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
