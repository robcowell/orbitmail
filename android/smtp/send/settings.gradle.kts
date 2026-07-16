// Standalone settings for `gradle test` on the JVM verification harness. The
// unified app build uses the root android/settings.gradle.kts and ignores this.
dependencyResolutionManagement {
    repositories { mavenCentral() }
}
rootProject.name = "orbit-smtp-send"
