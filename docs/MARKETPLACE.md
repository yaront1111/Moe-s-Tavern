# JetBrains Marketplace Submission Guide

This guide documents how to publish the Moe plugin to the JetBrains Marketplace.

## Prerequisites

- JetBrains Marketplace vendor account
- Plugin built and tested locally
- Screenshots of key features

## Building the Plugin

Use the Gradle wrapper (cross-platform):

```bash
# Mac/Linux
cd moe-jetbrains
./gradlew buildPlugin

# Windows
cd moe-jetbrains
.\gradlew.bat buildPlugin
```

The plugin zip will be created at `build/distributions/moe-jetbrains-0.1.0.zip`.

## Required Assets

### Plugin Icon

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

The plugin description is in `plugin.xml` using CDATA HTML format. Keep it:
- Under 700 characters for the short description
- Include feature list, compatibility info, and links

## Submission Process

1. **Create Vendor Account**
   - Go to https://plugins.jetbrains.com/
   - Sign in with JetBrains account
   - Create vendor profile

2. **Upload Plugin**
   - Click "Upload Plugin"
   - Select the zip file from `build/distributions/`
   - Fill in additional metadata

3. **Add Screenshots**
   - Upload 2-4 screenshots
   - Add captions describing each feature

4. **Submit for Review**
   - Review all information
   - Submit for JetBrains review
   - Wait for approval (typically 1-3 business days)

## Automated Publishing

The release workflow can publish automatically when `JETBRAINS_MARKETPLACE_TOKEN` is configured:

1. Generate token at https://plugins.jetbrains.com/author/me/tokens
2. Add as GitHub secret: `JETBRAINS_MARKETPLACE_TOKEN`
3. Create a new git tag (e.g., `v0.1.0`) to trigger release

The workflow runs:
```bash
./gradlew publishPlugin
```

## Version Updates

When releasing a new version:

1. Update version in `build.gradle.kts`
2. Update `<change-notes>` in `plugin.xml`
3. Create git tag
4. Release workflow handles the rest

## Compatibility

Current compatibility range:
- **Since Build**: 231 (IntelliJ 2023.1+)
- **Until Build**: Not specified (compatible with future versions)

Tested on:
- IntelliJ IDEA Community/Ultimate
- PyCharm Community/Professional
- WebStorm
- All 2023.1+ versions

## Troubleshooting

### Build Fails

```bash
# Clean and rebuild
./gradlew clean buildPlugin
```

### Plugin Not Loading

Check IDE version compatibility in `build.gradle.kts`:
```kotlin
patchPluginXml {
    sinceBuild.set("231")
    untilBuild.set("")
}
```

### Token Not Working

Ensure token has "Plugin Upload" permission and is not expired.
