import org.jetbrains.intellij.tasks.BuildPluginTask
import org.jetbrains.intellij.tasks.PrepareSandboxTask

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

val repoRoot = rootDir.parentFile ?: rootDir
val bundledDaemonDir = repoRoot.resolve("packages/moe-daemon/dist")
val bundledDaemonMain = bundledDaemonDir.resolve("index.js")
val bundledDaemonModules = repoRoot.resolve("packages/moe-daemon/node_modules")
val bundledDaemonMarker = bundledDaemonModules.resolve("chokidar")
val bundledProxyDir = repoRoot.resolve("packages/moe-proxy/dist")
val bundledProxyMain = bundledProxyDir.resolve("index.js")
val bundledProxyModules = repoRoot.resolve("packages/moe-proxy/node_modules")
val bundledProxyMarker = bundledProxyModules.resolve("ws")
val bundledAgentScript = repoRoot.resolve("scripts/moe-agent.ps1")
val bundledAgentScriptSh = repoRoot.resolve("scripts/moe-agent.sh")

fun requireBundledAssets() {
    check(bundledDaemonMain.exists()) {
        "Bundled moe-daemon dist not found at ${bundledDaemonMain}. " +
            "Build it first (cd packages/moe-daemon && npm run build)."
    }
    check(bundledDaemonMarker.exists()) {
        "Bundled moe-daemon dependencies not found at ${bundledDaemonModules}. " +
            "Install them first (cd packages/moe-daemon && npm install)."
    }
    check(bundledProxyMain.exists()) {
        "Bundled moe-proxy dist not found at ${bundledProxyMain}. " +
            "Build it first (cd packages/moe-proxy && npm run build)."
    }
    check(bundledProxyMarker.exists()) {
        "Bundled moe-proxy dependencies not found at ${bundledProxyModules}. " +
            "Install them first (cd packages/moe-proxy && npm install)."
    }
    check(bundledAgentScript.exists()) {
        "Bundled moe-agent.ps1 not found at ${bundledAgentScript}."
    }
    check(bundledAgentScriptSh.exists()) {
        "Bundled moe-agent.sh not found at ${bundledAgentScriptSh}."
    }
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
        sinceBuild.set("231")
        untilBuild.set("")  // No upper bound - compatible with all future versions
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

tasks.named<PrepareSandboxTask>("prepareSandbox") {
    doFirst { requireBundledAssets() }
    from(bundledDaemonDir) {
        into("daemon")
    }
    from(bundledDaemonModules) {
        into("daemon/node_modules")
        exclude("**/.bin/**")
    }
    from(bundledProxyDir) {
        into("proxy")
    }
    from(bundledProxyModules) {
        into("proxy/node_modules")
        exclude("**/.bin/**")
    }
    from(bundledAgentScript) {
        into("scripts")
    }
    from(bundledAgentScriptSh) {
        into("scripts")
    }
}

tasks.named<BuildPluginTask>("buildPlugin") {
    doFirst { requireBundledAssets() }
    from(bundledDaemonDir) {
        into("daemon")
    }
    from(bundledDaemonModules) {
        into("daemon/node_modules")
        exclude("**/.bin/**")
    }
    from(bundledProxyDir) {
        into("proxy")
    }
    from(bundledProxyModules) {
        into("proxy/node_modules")
        exclude("**/.bin/**")
    }
    from(bundledAgentScript) {
        into("scripts")
    }
    from(bundledAgentScriptSh) {
        into("scripts")
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
