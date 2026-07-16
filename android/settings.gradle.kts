// Unified Android application build wiring the seven deliverable modules into one
// app. Builds on a dev machine with the Android SDK + Google Maven (not in the
// sandbox). The per-module settings.gradle.kts files remain for standalone JVM
// verification (gradle test in each module) — Gradle reads THIS settings for the
// app build and ignores the included subprojects' own settings files.
//
// The JVM verification harnesses (data-layer/schema-verify, imap-spike) are NOT
// part of the app and are intentionally excluded.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "orbit-mail-android"

include(
    ":app",
    ":data:room",
    ":sync:engine",
    ":auth:core",
    ":auth:appauth",
    ":ui:presentation",
    ":ui:compose",
    ":background:policy",
    ":background:service",
    ":smtp:send",
    ":ai",
)

// Map logical Gradle paths to the on-disk module directories.
project(":data:room").projectDir = file("data-layer/room")
project(":sync:engine").projectDir = file("sync/engine")
project(":auth:core").projectDir = file("auth/core")
project(":auth:appauth").projectDir = file("auth/appauth")
project(":ui:presentation").projectDir = file("ui/presentation")
project(":ui:compose").projectDir = file("ui/compose")
project(":background:policy").projectDir = file("background/policy")
project(":background:service").projectDir = file("background/service")
project(":smtp:send").projectDir = file("smtp/send")
project(":ai").projectDir = file("ai")
