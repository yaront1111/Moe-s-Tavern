# JetBrains Marketplace Submission Guide

How the Moe's Tavern plugin (`com.moe.jetbrains`) is published to the JetBrains Marketplace. The end-to-end release procedure and the CI secrets for every channel (npm, VS Code Marketplace, Open VSX, JetBrains) are in [RELEASING.md](RELEASING.md).

## Prerequisites

- JetBrains Marketplace vendor account (https://plugins.jetbrains.com/)
- Plugin built and tested locally
- Screenshots of key features

## Building the plugin

The plugin build hard-fails unless the daemon **and** proxy each have `dist/` and `node_modules/`:

```bash
# Mac/Linux
(cd packages/moe-daemon && npm install && npm run build)
(cd packages/moe-proxy  && npm install && npm run build)
cd moe-jetbrains && ./gradlew buildPlugin

# Windows
cd packages\moe-daemon && npm install && npm run build && cd ..\..
cd packages\moe-proxy  && npm install && npm run build && cd ..\..
cd moe-jetbrains && .\gradlew.bat buildPlugin
```

The ZIP is written to `moe-jetbrains/build/distributions/moe-jetbrains-<version>.zip` (for example `moe-jetbrains-0.8.0.zip`; the version comes from `moe-jetbrains/build.gradle.kts`).

## Required assets

### Plugin icon

Located at `src/main/resources/META-INF/`:
- `pluginIcon.svg` - 40x40 SVG for light theme
- `pluginIcon_dark.svg` - 40x40 SVG for dark theme

### Screenshots

Marketplace requires screenshots showing the plugin in action:

1. **Board Overview** - Show the Kanban board with tasks in different columns
2. **Task Detail** - Show the task detail dialog with implementation plan
3. **Approval Flow** - Show a task awaiting approval with the approve/reject buttons

Screenshot requirements:
- PNG format
- Minimum 1280x800 pixels
- Both light and dark theme versions recommended
- No personal or sensitive information visible

### Description

The listing name, description and change notes come from `plugin.xml` (`<name>`, `<description>`, `<change-notes>`, CDATA HTML). Keep the description accurate to the current product and include the feature list, compatibility info, and links.

## Manual submission (first upload)

1. **Create vendor account** - sign in at https://plugins.jetbrains.com/ and create a vendor profile
2. **Upload plugin** - "Upload Plugin", select the ZIP from `build/distributions/`, fill in metadata
3. **Add screenshots** - 2-4 screenshots with captions
4. **Submit for review** - the first version of a new plugin goes through JetBrains moderation (typically 1-3 business days)

`./gradlew publishPlugin` can also create the listing on the first upload; it is still moderated the same way. Later versions publish without moderation.

## Automated publishing

The release workflow publishes when the `JETBRAINS_MARKETPLACE_TOKEN` secret is configured:

1. Generate a token at https://plugins.jetbrains.com/author/me/tokens
2. Add it as the GitHub secret `JETBRAINS_MARKETPLACE_TOKEN`
3. Push a release tag (e.g. `v0.8.0`) - see [RELEASING.md](RELEASING.md)

The workflow exports the secret as `PUBLISH_TOKEN`, which the IntelliJ Platform Gradle Plugin reads by default, and runs:

```bash
./gradlew publishPlugin
```

## Version updates

Follow [RELEASING.md](RELEASING.md): bump every package version (including `version` in `build.gradle.kts`), update `<change-notes>` in `plugin.xml`, run `node scripts/verify-release-version.mjs v<version>`, then push the tag.

## Compatibility

- **Since Build**: 231 (IntelliJ 2023.1+)
- **Until Build**: not set (no upper bound)
- Depends only on `com.intellij.modules.platform` (plus the optional terminal plugin), so it loads in any IntelliJ-based IDE

## Troubleshooting

### Build fails

```bash
./gradlew clean buildPlugin
```

If the error says the bundled daemon or proxy dist is missing or stale, rebuild them first (see above).

### Plugin not loading

Check the compatibility range in `build.gradle.kts`:

```kotlin
intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "231"
            untilBuild = provider { null }
        }
    }
}
```

### Token not working

Ensure the token has the "Plugin Upload" permission and is not expired.
