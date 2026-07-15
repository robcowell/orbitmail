plugins {
    kotlin("jvm") version "2.1.20"
}

repositories { mavenCentral() }

dependencies {
    // OkHttp + org.json both run on the JVM and Android. The audit (§7) chose a
    // REST client over the heavier Anthropic Java SDK for the on-device AI calls;
    // OkHttp is the lightweight, Android-native fit. org.json ships with Android.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
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
