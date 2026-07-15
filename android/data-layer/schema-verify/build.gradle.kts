plugins {
    kotlin("jvm") version "2.1.20"
}

repositories { mavenCentral() }

dependencies {
    // A real, modern SQLite engine (bundles SQLite ~3.49: window functions, FTS5,
    // partial indexes, foreign keys) reachable from Maven Central. We verify the
    // *SQL contract* the Room layer generates against this, since the Room /
    // androidx.sqlite artifacts live on Google Maven (blocked in this env).
    implementation("org.xerial:sqlite-jdbc:3.49.1.0")

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
