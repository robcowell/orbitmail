plugins {
    kotlin("jvm") version "2.1.20"
}

repositories { mavenCentral() }

dependencies {
    // Jakarta Mail SMTP Transport. The IMAP spike proved this line Android-safe;
    // on Android the app provides com.sun.mail:android-mail (identical javax.mail
    // API), so compile against the API but DON'T export it — exporting jakarta.mail
    // to the app would collide with android-mail (duplicate classes).
    compileOnly("com.sun.mail:jakarta.mail:1.6.7")
    testImplementation("com.sun.mail:jakarta.mail:1.6.7")

    // End-to-end: submit through a real in-process SMTP server.
    testImplementation("com.icegreen:greenmail-junit5:1.6.15")
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
