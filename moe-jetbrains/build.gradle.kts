import org.jetbrains.intellij.platform.gradle.tasks.BuildPluginTask
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.20.0"
}

group = "com.moe"
version = "0.8.0"

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
val bundledDaemonLock = repoRoot.resolve("packages/moe-daemon/package-lock.json")
val bundledProxyLock = repoRoot.resolve("packages/moe-proxy/package-lock.json")
// Compiled tests never ship; the dist copies and the import scan below share this list.
val distTestExcludes = listOf("**/*.test.*", "**/*.spec.*")

// The scripts and docs to bundle come from one manifest, which moe-vscode/scripts/bundle-assets.mjs reads too;
// its comment member states the copy rules. The daemon and proxy copies stay below, beside their checks.
val bundleManifest = repoRoot.resolve("scripts/bundle-manifest.json")

data class BundleCopy(val from: String, val into: String, val files: List<String>, val required: List<String>, val exclude: List<String>)

fun malformedManifest(what: String): Nothing = throw GradleException("Bundle manifest $bundleManifest is malformed: $what")

fun manifestString(key: String, value: Any?, isPath: Boolean): String {
    if (value !is String || value.isEmpty()) malformedManifest("$key must be a non-empty string")
    if (isPath && (value.startsWith("/") || value.startsWith("\\") || File(value).isAbsolute || value.split('/', '\\').contains(".."))) {
        malformedManifest("$key ($value) must be a relative path with no .. segment")
    }
    return value
}

fun manifestList(key: String, value: Any?, arePaths: Boolean): List<String> = when (value) {
    null -> emptyList()
    is List<*> -> value.mapIndexed { i, item -> manifestString("$key[$i]", item, arePaths) }
    else -> malformedManifest("$key must be an array of non-empty strings")
}

val bundleCopies: List<BundleCopy> by lazy {
    val text = try { bundleManifest.readText() } catch (e: java.io.IOException) {
        throw GradleException("Bundle manifest $bundleManifest is unreadable: ${e.message}")
    }
    val parsed = try { groovy.json.JsonSlurper().parseText(text) } catch (e: Exception) { malformedManifest("${e.message}") }
    val copies = (parsed as? Map<*, *>)?.get("copies")
    if (copies !is List<*> || copies.isEmpty()) malformedManifest("copies must be a non-empty array")
    copies.mapIndexed { i, entry ->
        if (entry !is Map<*, *>) malformedManifest("copies[$i] must be an object")
        BundleCopy(
            from = manifestString("copies[$i].from", entry["from"], isPath = true),
            into = manifestString("copies[$i].into", entry["into"], isPath = true),
            files = manifestList("copies[$i].files", entry["files"], arePaths = true),
            required = manifestList("copies[$i].required", entry["required"], arePaths = true),
            exclude = manifestList("copies[$i].exclude", entry["exclude"], arePaths = false),
        )
    }
}

// A package-lock.json packages key: node_modules/<name>, optionally nested (node_modules/a/node_modules/b).
val lockfileKey = Regex("""node_modules/(?:@[^/\\]+/)?[^/\\]+(?:/node_modules/(?:@[^/\\]+/)?[^/\\]+)*""")

// The lockfile's production packages as paths under node_modules ("chokidar", "pino-pretty/node_modules/sonic-boom"):
// every entry not marked "dev": true, optional and peer ones included. An unusable lockfile fails the build;
// nothing falls back to copying the whole tree.
fun productionPackages(lockfile: File): List<String> {
    fun bad(what: String): Nothing = throw GradleException("Lockfile $lockfile $what")
    val text = try { lockfile.readText() } catch (e: java.io.IOException) { bad("is missing or unreadable: ${e.message}") }
    val parsed = try { groovy.json.JsonSlurper().parseText(text) } catch (e: Exception) { bad("is not valid JSON: ${e.message}") }
    val packages = (parsed as? Map<*, *>)?.get("packages") as? Map<*, *>
        ?: bad("has no packages map (npm lockfileVersion 2 or newer is required)")
    return packages.mapNotNull { (key, entry) ->
        if (key !is String || !key.startsWith("node_modules/")) return@mapNotNull null
        if (entry !is Map<*, *>) bad("entry $key must be an object")
        if (!lockfileKey.matches(key) || key.split('/').any { it == "." || it == ".." }) bad("key $key is not a node_modules package path")
        if (entry["dev"] == true) return@mapNotNull null
        // npm creates a link even for an optional entry, and its target lies outside node_modules.
        if (entry["link"] == true) bad("entry $key is a link, which cannot be bundled")
        key.removePrefix("node_modules/")
    }.sorted()
}

val daemonPackages: List<String> by lazy { productionPackages(bundledDaemonLock) }
val proxyPackages: List<String> by lazy { productionPackages(bundledProxyLock) }

// Newest mtime of any non-test source file under src. Guards against bundling
// a dist that predates the sources — an old dist ships silently and resurrects
// removed daemon behavior (e.g. the pre-3d2cb16 idle-based worker sweep)
// inside every installed plugin.
fun newestSourceMtime(srcDir: java.io.File): Long =
    srcDir.walkTopDown()
        .filter { it.isFile && !it.name.contains(".test.") }
        .map { it.lastModified() }
        .maxOrNull() ?: 0L

fun requireFreshDist(name: String, distMain: java.io.File, srcDir: java.io.File) {
    if (!srcDir.exists()) return
    check(distMain.lastModified() >= newestSourceMtime(srcDir)) {
        "Bundled $name dist at ${distMain.parentFile} is STALE (source files are newer than dist). " +
            "Rebuild first (cd packages/$name && npm run build) — bundling an old dist ships outdated daemon behavior."
    }
}

fun requireBundledAssets() {
    check(bundledDaemonMain.exists()) {
        "Bundled moe-daemon dist not found at ${bundledDaemonMain}. " +
            "Build it first (cd packages/moe-daemon && npm run build)."
    }
    requireFreshDist("moe-daemon", bundledDaemonMain, repoRoot.resolve("packages/moe-daemon/src"))
    check(bundledDaemonMarker.exists()) {
        "Bundled moe-daemon dependencies not found at ${bundledDaemonModules}. " +
            "Install them first (cd packages/moe-daemon && npm install)."
    }
    check(bundledProxyMain.exists()) {
        "Bundled moe-proxy dist not found at ${bundledProxyMain}. " +
            "Build it first (cd packages/moe-proxy && npm run build)."
    }
    requireFreshDist("moe-proxy", bundledProxyMain, repoRoot.resolve("packages/moe-proxy/src"))
    check(bundledProxyMarker.exists()) {
        "Bundled moe-proxy dependencies not found at ${bundledProxyModules}. " +
            "Install them first (cd packages/moe-proxy && npm install)."
    }
    // Every manifest source is checked before anything is copied.
    bundleCopies.forEach { copy ->
        val dir = repoRoot.resolve(copy.from)
        check(dir.isDirectory) { "Bundled ${copy.from} not found at $dir." }
        (copy.files + copy.required).forEach { name ->
            check(dir.resolve(name).isFile) { "Bundled ${copy.from}/$name not found at $dir." }
        }
    }
}

// The dist files the copies ship, and the four ways they can name a package: static from, side-effect import,
// dynamic import() and require(). Group 2 is the specifier.
val daemonDistScripts = fileTree(bundledDaemonDir) { include("**/*.js", "**/*.mjs", "**/*.cjs"); exclude(distTestExcludes) }
val proxyDistScripts = fileTree(bundledProxyDir) { include("**/*.js", "**/*.mjs", "**/*.cjs"); exclude(distTestExcludes) }
val importSpecifiers = listOf(
    Regex("""(?m)^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1"""),
    Regex("""(?m)^\s*import\s*(['"])([^'"\n]+)\1"""),
    Regex("""\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)"""),
    Regex("""\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)"""),
)
// A URL scheme covers node:, file: and data: specifiers.
val urlScheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")
// Node 24's module.builtinModules reduced to top-level names; the dist imports fs, path and others unprefixed.
val nodeBuiltins = setOf(
    "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server",
    "_stream_duplex", "_stream_passthrough", "_stream_readable", "_stream_transform", "_stream_wrap",
    "_stream_writable", "_tls_common", "_tls_wrap", "assert", "async_hooks", "buffer", "child_process",
    "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events",
    "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
    "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
)

// Bare imports in one dist file that resolve to no shipped top-level package, as "'<spec>' (<file>:<line>)".
fun unshippedImports(file: File, distDir: File, shipped: Set<String>): List<String> {
    val text = file.readText()
    return importSpecifiers.flatMap { it.findAll(text) }.sortedBy { it.groups[2]!!.range.first }.mapNotNull { match ->
        val spec = match.groupValues[2]
        if (spec.startsWith(".") || spec.startsWith("/") || urlScheme.containsMatchIn(spec)) return@mapNotNull null
        val segments = spec.split('/')
        val name = if (spec.startsWith("@")) segments.take(2).joinToString("/") else segments[0]
        if (name in nodeBuiltins || name in shipped) return@mapNotNull null
        // The specifier's own line: a leading ^\s* can start the match on an earlier blank line.
        val line = 1 + text.substring(0, match.groups[2]!!.range.first).count { it == '\n' }
        "'$spec' (${file.relativeTo(distDir).invariantSeparatorsPath}:$line)"
    }.distinct()
}

fun bundleProblems(pkg: String, lockfile: File, modules: File, packages: List<String>, distDir: File, scripts: FileTree): List<String> {
    // Gradle's from() of a missing directory copies nothing, so this is the only stop for an absent runtime package.
    val missing = packages.filterNot { modules.resolve("$it/package.json").isFile }
    // Only top-level entries resolve from dist/; a nested one serves its parent package alone.
    val shipped = packages.filterNot { "/node_modules/" in it }.toSet()
    val unshipped = scripts.files.sorted().flatMap { unshippedImports(it, distDir, shipped) }
    return listOfNotNull(
        missing.takeIf { it.isNotEmpty() }?.let {
            "Bundled $pkg production packages from $lockfile are missing at $modules (run npm ci in packages/$pkg): ${it.joinToString()}"
        },
        unshipped.takeIf { it.isNotEmpty() }?.let {
            "Bundled $pkg dist imports packages its bundled node_modules does not ship (devDependencies are not bundled): ${it.joinToString()}"
        },
    )
}

// Checks both packages before anything is copied and reports every problem in one failure.
fun requireBundledPackages() {
    val problems = bundleProblems("moe-daemon", bundledDaemonLock, bundledDaemonModules, daemonPackages, bundledDaemonDir, daemonDistScripts) +
        bundleProblems("moe-proxy", bundledProxyLock, bundledProxyModules, proxyPackages, bundledProxyDir, proxyDistScripts)
    if (problems.isNotEmpty()) throw GradleException(problems.joinToString("\n"))
}

dependencies {
    intellijPlatform {
        intellijIdea("2026.2.3")
    }
    implementation("com.google.code.gson:gson:2.15.0")
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
        gradleVersion = "9.8.2"
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
            // Plain JUnit has no IDE launcher to point JNA at the SDK's native library, which protected runtime
            // selection reads drive mappings through on Windows. Without it every protected Windows test would refuse.
            if (System.getProperty("os.name").startsWith("Windows")) {
                val arch = when (System.getProperty("os.arch").lowercase()) {
                    "amd64", "x86_64" -> "amd64"
                    "aarch64", "arm64" -> "aarch64"
                    else -> error("The IntelliJ SDK ships no JNA library for Windows on ${System.getProperty("os.arch")}.")
                }
                val jna = classpath.files.firstOrNull { it.name == "util-8.jar" }?.resolveSibling("jna/$arch")
                check(jna != null && jna.resolve("jnidispatch.dll").isFile) { "The IntelliJ SDK's JNA native library is not at $jna." }
                systemProperty("jna.boot.library.path", jna.absolutePath)
            }
        }
    }
}

// Bundle daemon, proxy, agent scripts, and docs into <pluginName>/ in the sandbox.
// In IntelliJ Platform Gradle Plugin 2.x, prepareSandbox is the canonical place; buildPlugin
// zips the sandbox automatically.
val pluginContentRoot = "${rootProject.name}"

tasks.named<PrepareSandboxTask>("prepareSandbox") {
    doFirst {
        requireBundledAssets()
        requireBundledPackages()
    }
    // moe-proxy's tsconfig compiles src/*.test.ts, and compiled tests never ship.
    from(bundledDaemonDir) {
        into("$pluginContentRoot/daemon")
        exclude(distTestExcludes)
    }
    from(bundledProxyDir) {
        into("$pluginContentRoot/proxy")
        exclude(distTestExcludes)
    }
    // Each node_modules ships only its lockfile's production packages. The devDependencies (typescript,
    // vitest, tsx, @types/*: about 168 MB across both trees, VSC-0 D8) stay out. Every entry is copied
    // without its own nested node_modules, because a nested production package is a lockfile entry of its
    // own; so a dev-only nested package never ships. requireBundledPackages checks the dist against this set.
    daemonPackages.forEach { rel ->
        from(bundledDaemonModules.resolve(rel)) {
            into("$pluginContentRoot/daemon/node_modules/$rel")
            exclude("node_modules/**")
        }
    }
    proxyPackages.forEach { rel ->
        from(bundledProxyModules.resolve(rel)) {
            into("$pluginContentRoot/proxy/node_modules/$rel")
            exclude("node_modules/**")
        }
    }
    // Ship each package.json next to its dist: both dists are ESM, and without
    // "type": "module" beside them only node >= 22.7 (ESM syntax auto-detection)
    // can run the .js files. A WSL distro's node 18/20 fails with "Cannot use
    // import statement outside a module" on every proxy RPC.
    from(repoRoot.resolve("packages/moe-daemon/package.json")) {
        into("$pluginContentRoot/daemon")
    }
    from(repoRoot.resolve("packages/moe-proxy/package.json")) {
        into("$pluginContentRoot/proxy")
    }
    bundleCopies.forEach { copy ->
        from(repoRoot.resolve(copy.from)) {
            into("$pluginContentRoot/${copy.into}")
            if (copy.files.isEmpty()) {
                exclude(copy.exclude)
            } else {
                include(copy.files)
                // A CRLF working-tree checkout (core.autocrlf) would ship a script WSL bash can't parse.
                filesMatching("**/*.sh") {
                    filter(
                        mapOf("eol" to org.apache.tools.ant.filters.FixCrLfFilter.CrLf.newInstance("lf")),
                        org.apache.tools.ant.filters.FixCrLfFilter::class.java,
                    )
                }
            }
        }
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
