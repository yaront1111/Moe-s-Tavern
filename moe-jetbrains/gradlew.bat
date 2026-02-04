@echo off
setlocal

set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
if not exist "%DIR%\gradle\wrapper\gradle-wrapper.jar" (
  if exist "%DIR%\scripts\ensure-wrapper.ps1" (
    powershell -ExecutionPolicy Bypass -File "%DIR%\scripts\ensure-wrapper.ps1" -ProjectRoot "%DIR%"
  )
)
if exist "%DIR%\gradle\wrapper\gradle-wrapper.jar" goto run
echo Gradle wrapper missing. Falling back to system gradle.
gradle %*
exit /b %ERRORLEVEL%

:run
set "CP=%DIR%\gradle\wrapper\gradle-wrapper.jar"
if exist "%DIR%\gradle\wrapper\gradle-wrapper-shared.jar" set "CP=%CP%;%DIR%\gradle\wrapper\gradle-wrapper-shared.jar"
if exist "%DIR%\gradle\wrapper\gradle-cli.jar" set "CP=%CP%;%DIR%\gradle\wrapper\gradle-cli.jar"
java -Dorg.gradle.appname=gradlew -classpath "%CP%" org.gradle.wrapper.GradleWrapperMain %*
