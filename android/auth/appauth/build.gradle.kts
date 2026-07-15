// Android library: AppAuth integration for Gmail + Microsoft OAuth.
//
// NOT built in this sandbox (needs the Android SDK; AppAuth is an AAR on Google
// Maven, which the proxy blocks). Build it from the Android app project. The
// provider-agnostic logic it relies on (PKCE, scopes, auth-URL, token refresh,
// state, token parsing) is verified off-device in ../core (`gradle test`).

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "orbit.auth.appauth"
    compileSdk = 35
    defaultConfig {
        minSdk = 26
        // The redirect scheme AppAuth's RedirectUriReceiverActivity listens on.
        // Google: the reversed OAuth client id. Provide via manifestPlaceholders
        // per build flavor / from BuildConfig.
        manifestPlaceholders["appAuthRedirectScheme"] = "com.orbitmail.app"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // The audit's chosen OAuth stack: AppAuth-Android + Chrome Custom Tabs.
    implementation("net.openid:appauth:0.11.1")
    implementation("androidx.browser:browser:1.8.0") // Custom Tabs
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")

    // The verified pure-Kotlin OAuth core (config, token model, refresh logic).
    // In the app build this is a project dependency: implementation(project(":auth:core"))
}
