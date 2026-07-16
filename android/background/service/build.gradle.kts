// Android library: background sync machinery (plan §2 / build-order Step 6).
//
// NOT built in this sandbox (Android SDK + WorkManager/AndroidX on Google Maven,
// both blocked). Build from the app project. The scheduling/notification policy
// it executes is the ../policy module, verified off-device (gradle test).

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "orbit.bg.service"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":background:policy")) // verified decision logic
    implementation(project(":sync:engine"))        // Step 4: SyncEngine + ImapConnectionFactory
    implementation(project(":auth:appauth"))       // Step 3: freshAccessToken
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("com.sun.mail:android-mail:1.6.7") // blocking IDLE (spike Finding 2)
    implementation("com.sun.mail:android-activation:1.6.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
}
