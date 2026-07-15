// Root build for the unified Android app. Declares the plugins used across
// modules (versions come from gradle/libs.versions.toml) without applying them
// here — each module applies the ones it needs.

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.ksp) apply false
}
