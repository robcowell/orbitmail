plugins {
    kotlin("jvm") version "2.1.20"
}

repositories { mavenCentral() }

dependencies {
    // Pure Kotlin — no Android, no Compose. This is the UI *logic* (state
    // reduction, reply composition, formatting) that the Compose layer renders
    // and the ViewModels drive, so it is unit-tested off-device. java.time is
    // available on Android (minSdk 26), so MailFormat runs on both.
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin { jvmToolchain(21) }

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
