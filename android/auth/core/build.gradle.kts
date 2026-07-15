plugins {
    kotlin("jvm") version "2.1.20"
}

repositories { mavenCentral() }

dependencies {
    // org.json is part of the Android platform, so this same code compiles and
    // runs on Android with no extra dependency. Here we pull the Maven Central
    // build to run the tests off-device.
    implementation("org.json:json:20240303")

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
