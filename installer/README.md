# Moe Installer

This folder contains assets and scripts for building a one-click Windows installer.

## Prereqs
- Node.js 18+
- Gradle (or gradlew)
- Inno Setup (ISCC)

## Build Steps (Windows)

1) Build daemon + proxy
```powershell
cd D:\projexts\moes
.\scripts\install-all.ps1 -InstallPlugin $false
```

2) Build or provide plugin ZIP
```powershell
cd D:\projexts\moes\moe-jetbrains
.\gradlew.bat buildPlugin
```

3) Copy assets for installer (or pass a prebuilt ZIP)
```powershell
.\scripts\build-installer.ps1 -PluginZip D:\path\to\moe-jetbrains.zip
```

4) Build installer
```powershell
ISCC .\installer\moe-installer.iss
```

The EXE will appear in `installer/output/`.

## Notes
- The installer sets `MOE_DAEMON_COMMAND` to the installed daemon shim.
- The plugin auto-starts the daemon when PyCharm opens a project.
