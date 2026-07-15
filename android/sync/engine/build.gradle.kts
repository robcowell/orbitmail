plugins {
    kotlin("jvm") version "2.1.20"
}

repositories { mavenCentral() }

dependencies {
    // Same Jakarta Mail line proven Android-compatible by the IMAP spike. On
    // Android, swap to com.sun.mail:android-mail:1.6.7 — identical javax.mail API.
    implementation("com.sun.mail:jakarta.mail:1.6.7")

    // End-to-end tests: real in-process IMAP/SMTP server + a SQLite-backed
    // MailRepository so the engine's algorithms run against real infrastructure.
    testImplementation("com.icegreen:greenmail-junit5:1.6.15")
    testImplementation("org.xerial:sqlite-jdbc:3.49.1.0")
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
