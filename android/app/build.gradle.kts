plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "orbit.mail"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.orbitmail.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // OAuth client ids + redirect scheme (see android/auth/OAUTH_SETUP.md).
        // Real values come from a gitignored keystore.properties / CI secrets.
        buildConfigField("String", "GOOGLE_CLIENT_ID", "\"${providers.gradleProperty("GOOGLE_CLIENT_ID").getOrElse("")}\"")
        buildConfigField("String", "MICROSOFT_CLIENT_ID", "\"${providers.gradleProperty("MICROSOFT_CLIENT_ID").getOrElse("")}\"")
        buildConfigField("String", "MICROSOFT_TENANT_ID", "\"${providers.gradleProperty("MICROSOFT_TENANT_ID").getOrElse("common")}\"")
        manifestPlaceholders["appAuthRedirectScheme"] = providers.gradleProperty("APPAUTH_REDIRECT_SCHEME").getOrElse("com.orbitmail.app")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // ── the seven deliverable modules ────────────────────────────────────────
    implementation(project(":data:room"))       // Step 2
    implementation(project(":sync:engine"))      // Step 4
    implementation(project(":auth:core"))        // Step 3
    implementation(project(":auth:appauth"))     // Step 3
    implementation(project(":ui:presentation"))  // Step 5 (logic)
    implementation(project(":ui:compose"))       // Step 5 (screens)
    implementation(project(":background:policy")) // Step 6
    implementation(project(":background:service")) // Step 6
    implementation(project(":ai"))               // Step 7

    // ── Android platform ─────────────────────────────────────────────────────
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.security.crypto)     // Keystore-backed prefs (Steps 3, 7)
    implementation(libs.androidx.work.runtime.ktx)    // Step 6
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.android.mail)                 // Step 1/4 IMAP/SMTP
    implementation(libs.android.activation)

    // Compose
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)

    coreLibraryDesugaring(libs.desugar.jdk.libs)
}
