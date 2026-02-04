plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.0"
    id("org.jetbrains.intellij") version "1.17.2"
}

group = "com.moe"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.java-websocket:Java-WebSocket:1.5.5")
}

intellij {
    version.set("2025.2")
    type.set("IC")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks {
    patchPluginXml {
        sinceBuild.set("252")
        untilBuild.set("252.*")
    }

    wrapper {
        gradleVersion = "8.10.2"
        distributionType = Wrapper.DistributionType.BIN
    }

    // Avoid requiring offline instrumentation dependencies.
    named("instrumentCode") {
        enabled = false
    }

    named("buildSearchableOptions") {
        enabled = false
    }
}

kotlin {
    // Use a Java 21 toolchain if available, but target Java 17 bytecode.
    jvmToolchain(21)
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinOptions.jvmTarget = "17"
    kotlinOptions.freeCompilerArgs += "-Xskip-metadata-version-check"
}
