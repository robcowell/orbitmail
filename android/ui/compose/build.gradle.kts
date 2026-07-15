// Android app module: Jetpack Compose UI (audit §1 stack).
//
// NOT built in this sandbox — Compose + AndroidX live on Google Maven (blocked)
// and there is no Android SDK. Build from the app project. The UI *logic* these
// screens/ViewModels use (state reduction, reply composition, formatting,
// search) is the ../presentation module, verified off-device (gradle test).

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "orbit.mail"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.orbitmail.app"
        minSdk = 26
        targetSdk = 35
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true // java.time on minSdk 26 is fine; kept for safety
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // implementation(project(":ui:presentation")) // the verified UI logic
    // implementation(project(":data:room"))       // Step 2
    // implementation(project(":sync:engine"))      // Step 4
    // implementation(project(":auth:appauth"))     // Step 3

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.3")
}
