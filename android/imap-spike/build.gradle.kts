plugins {
    kotlin("jvm") version "2.1.20"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // ── The IMAP/SMTP client library under evaluation ────────────────────────
    // com.sun.mail:jakarta.mail:1.6.7 is the JVM-runnable impl of the Jakarta
    // Mail 1.6 line (Java package `javax.mail`). On Android you swap ONLY the
    // artifact for the byte-identical Android build — the API and the IMAP
    // protocol implementation are the same code:
    //
    //     implementation("com.sun.mail:android-mail:1.6.7")
    //     implementation("com.sun.mail:android-activation:1.6.7")
    //
    // We use the plain JVM artifact here so the spike runs in this environment;
    // every API referenced in src/main + src/test exists identically in
    // android-mail:1.6.7 (verified via the Jakarta Mail sources — same package).
    implementation("com.sun.mail:jakarta.mail:1.6.7")

    // ── End-to-end test harness: a real, in-process IMAP/SMTP server ─────────
    // GreenMail speaks real IMAP (incl. IDLE) over a loopback socket, so the
    // client drives an actual protocol conversation — not a mock. 1.6.15 is the
    // last javax.mail-namespace line, matching the client above (one consistent
    // javax.mail on the classpath).
    testImplementation("com.icegreen:greenmail-junit5:1.6.15")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

application {
    // Layer 3: real-Gmail runner. See RealGmailSpike.kt for usage.
    mainClass.set("orbit.spike.MainKt")
}
