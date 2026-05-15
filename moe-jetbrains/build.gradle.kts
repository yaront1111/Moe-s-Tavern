import org.jetbrains.intellij.platform.gradle.tasks.BuildPluginTask
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.16.0"
}

group = "com.moe"
version = "0.6.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
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
val bundledRoleDocs = repoRoot.resolve("docs/roles")
val bundledAgentContext = repoRoot.resolve("docs/agent-context.md")
val bundledSkillsDir = repoRoot.resolve("docs/skills")

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
    intellijPlatform {
        intellijIdeaCommunity("2025.2")
    }
    implementation("com.google.code.gson:gson:2.14.0")
    implementation("org.java-websocket:Java-WebSocket:1.6.0")
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "231"
            untilBuild = provider { null }  // No upper bound
        }
    }
    buildSearchableOptions = false
    instrumentCode = false
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks {
    wrapper {
        gradleVersion = "9.5.1"
        distributionType = Wrapper.DistributionType.BIN
    }

    test {
        useJUnit()
        jvmArgs("--add-opens=java.base/sun.nio.fs=ALL-UNNAMED")
        doFirst {
            jvmArgumentProviders.removeAll {
                it.javaClass.name.contains("IntelliJPlatformArgumentProvider")
            }
            systemProperties.remove("java.system.class.loader")
            val filteredJvmArgs = (jvmArgs ?: emptyList()).filterNot {
                it.contains("java.system.class.loader")
            }
            setJvmArgs(filteredJvmArgs)
        }
    }
}

// Bundle daemon, proxy, agent scripts, and docs into <pluginName>/ in the sandbox.
// In IntelliJ Platform Gradle Plugin 2.x, prepareSandbox is the canonical place; buildPlugin
// zips the sandbox automatically.
val pluginContentRoot = "${rootProject.name}"

tasks.named<PrepareSandboxTask>("prepareSandbox") {
    doFirst { requireBundledAssets() }
    from(bundledDaemonDir) {
        into("$pluginContentRoot/daemon")
    }
    from(bundledDaemonModules) {
        into("$pluginContentRoot/daemon/node_modules")
        exclude("**/.bin/**")
    }
    from(bundledProxyDir) {
        into("$pluginContentRoot/proxy")
    }
    from(bundledProxyModules) {
        into("$pluginContentRoot/proxy/node_modules")
        exclude("**/.bin/**")
    }
    from(bundledAgentScript) {
        into("$pluginContentRoot/scripts")
    }
    from(bundledAgentScriptSh) {
        into("$pluginContentRoot/scripts")
    }
    from(bundledRoleDocs) {
        into("$pluginContentRoot/docs/roles")
    }
    from(bundledAgentContext) {
        into("$pluginContentRoot/docs")
    }
    from(bundledSkillsDir) {
        into("$pluginContentRoot/docs/skills")
    }
}

kotlin {
    // Target Java 17 bytecode; toolchain must match Java target (enforced by
    // IntelliJ Platform Gradle Plugin 2.16+).
    jvmToolchain(17)
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
