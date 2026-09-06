#!/usr/bin/env bash
# Source this helper so newly installed tools are usable by the caller immediately.
# Official distributions: nodejs.org/dist, npmjs.org (provider-owned CLI packages).

moe_dependency_error() { printf '[ERROR] %s\n' "$*" >&2; return 1; }
moe_has_tool() {
    command -v "$1" >/dev/null 2>&1 || return 1
    if [ "$1" = tmux ]; then "$1" -V >/dev/null 2>&1; else "$1" --version >/dev/null 2>&1; fi
}

moe_node_ready() {
    local version major minor
    version=$(node --version 2>/dev/null) || return 1
    version=${version#v}
    major=${version%%.*}
    minor=${version#*.}; minor=${minor%%.*}
    [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
    { [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; } || [ "$major" -eq 24 ] || [ "$major" -eq 26 ]
}

moe_package_install() {
    local os_name=$1
    shift
    local elevate=()
    if [ "$os_name" = Darwin ]; then
        if ! moe_has_tool brew; then
            moe_dependency_error 'Homebrew is required to install missing macOS dependencies. Install it from https://brew.sh (and its Command Line Tools prerequisites), then rerun this installer.'
            return 1
        fi
        brew install "$@" || return
    else
        if [ "$(id -u)" -ne 0 ]; then
            if ! command -v sudo >/dev/null 2>&1; then
                moe_dependency_error 'Installing system dependencies requires sudo or a root shell. Ask your system administrator to install the listed packages, then rerun.'
                return 1
            fi
            elevate=(sudo)
        fi
        if moe_has_tool apt-get; then
            "${elevate[@]}" apt-get update || return
            "${elevate[@]}" apt-get install -y "$@" || return
        elif moe_has_tool dnf; then
            local translated=() package
            for package in "$@"; do
                case "$package" in
                    openjdk-17-jdk) translated+=(java-17-openjdk-devel) ;;
                    *) translated+=("$package") ;;
                esac
            done
            "${elevate[@]}" dnf install -y "${translated[@]}" || return
        else
            moe_dependency_error "No supported package manager found. Automatic Linux installation supports apt-get or dnf. Install these dependencies with your distribution's manager, then rerun: $*"
            return 1
        fi
    fi
    hash -r
}

moe_install_node() (
    set -e
    local node_os=$1 node_arch=$2 node_root download_dir line_hash line_file archive='' expected=''
    node_root="$HOME/.local/share/moe/node"
    mkdir -p "$node_root" || exit
    download_dir=$(mktemp -d "$node_root/.download.XXXXXX") || exit
    trap 'rm -rf "$download_dir"' EXIT
    local base_url='https://nodejs.org/dist/latest-v24.x'
    printf 'Installing Node.js 24 from %s\n' "$base_url"
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 180 --output "$download_dir/SHASUMS256.txt" "$base_url/SHASUMS256.txt" || exit
    while read -r line_hash line_file; do
        if [[ "$line_file" =~ ^node-v24\.[0-9]+\.[0-9]+-${node_os}-${node_arch}\.tar\.gz$ ]]; then
            archive=$line_file
            expected=$line_hash
            break
        fi
    done < "$download_dir/SHASUMS256.txt"
    if [[ -z "$archive" || ! "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then
        moe_dependency_error "Official Node.js checksum manifest has no supported $node_os/$node_arch archive."
        exit 1
    fi
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 --output "$download_dir/$archive" "$base_url/$archive" || exit
    local actual
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$download_dir/$archive") || exit
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$download_dir/$archive") || exit
    else
        moe_dependency_error 'A SHA256 tool (sha256sum or shasum) is required; refusing to install an unverified download.'
        exit 1
    fi
    actual=${actual%% *}
    if [ "$actual" != "$expected" ]; then
        moe_dependency_error 'Node.js archive checksum mismatch; nothing was extracted.'
        exit 1
    fi
    tar -xzf "$download_dir/$archive" -C "$download_dir" || exit
    local package_dir=${archive%.tar.gz}
    "$download_dir/$package_dir/bin/node" --version >/dev/null || exit
    PATH="$download_dir/$package_dir/bin:$PATH" "$download_dir/$package_dir/bin/npm" --version >/dev/null || exit
    # A completed version is immutable; select it only after both executables work.
    if [ ! -e "$node_root/$package_dir" ]; then
        mv "$download_dir/$package_dir" "$node_root/$package_dir" || exit
    fi
    if [ -e "$node_root/current" ] && [ ! -L "$node_root/current" ]; then
        moe_dependency_error "Expected an installer-owned symlink at $node_root/current; preserve that directory and move it aside before retrying."
        exit 1
    fi
    ln -sfn "$node_root/$package_dir" "$node_root/current" || exit
)

moe_java17_ready() {
    local version
    version=$(javac --version 2>/dev/null) || return 1
    [[ "$version" == 'javac 17.'* ]]
}

moe_select_java17() {
    local candidate version
    for candidate in "${JAVA_HOME:-}" /usr/lib/jvm/*17* /Library/Java/JavaVirtualMachines/*17*/Contents/Home; do
        [ -n "$candidate" ] && [ -x "$candidate/bin/javac" ] || continue
        version=$("$candidate/bin/javac" --version 2>/dev/null) || continue
        if [[ "$version" == 'javac 17.'* ]]; then
            export JAVA_HOME="$candidate"
            export PATH="$JAVA_HOME/bin:$PATH"
            return 0
        fi
    done
    moe_java17_ready
}

moe_persist_environment() {
    local env_dir="$HOME/.local/share/moe" profile line
    mkdir -p "$env_dir" || return
    cat > "$env_dir/env.sh" <<'ENV' || return
# Moe installer tools; existing shell settings are preserved.
case ":$PATH:" in *":$HOME/.local/share/moe/node/current/bin:"*) ;; *) export PATH="$HOME/.local/share/moe/node/current/bin:$PATH" ;; esac
case ":$PATH:" in *":$HOME/.local/share/moe/npm/bin:"*) ;; *) export PATH="$HOME/.local/share/moe/npm/bin:$PATH" ;; esac
ENV
    line='[ ! -f "$HOME/.local/share/moe/env.sh" ] || . "$HOME/.local/share/moe/env.sh"'
    local profiles=()
    case "${SHELL:-/bin/bash}" in
        */zsh) profiles+=("${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zprofile") ;;
        *)
            profiles+=("$HOME/.bashrc")
            # Bash reads only the first existing login file in this order.
            if [ -f "$HOME/.bash_profile" ]; then profiles+=("$HOME/.bash_profile")
            elif [ -f "$HOME/.bash_login" ]; then profiles+=("$HOME/.bash_login")
            else profiles+=("$HOME/.profile")
            fi
            ;;
    esac
    for profile in "${profiles[@]}"; do
        if ! [ -f "$profile" ] || ! grep -Fqx "$line" "$profile"; then
            printf '\n# Moe command PATH\n%s\n' "$line" >> "$profile" || return
        fi
    done
    printf 'New terminals load Moe tools automatically. In an existing terminal run:\n  . "$HOME/.local/share/moe/env.sh"\n'
}

moe_install_dependencies() {
    local agent=${1:-claude} with_plugin=${2:-false} os_name arch node_os node_arch
    case "$agent" in claude|codex|gemini|none) ;; *) moe_dependency_error 'Choose --agent claude, codex, gemini, or none.'; return 1 ;; esac
    os_name=$(uname -s)
    case "$os_name" in Darwin) node_os=darwin ;; Linux) node_os=linux ;; *) moe_dependency_error "Automatic dependency installation does not support $os_name. Use the Windows PowerShell installer on Windows."; return 1 ;; esac
    arch=$(uname -m)
    case "$arch" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) moe_dependency_error "Unsupported CPU architecture: $arch (supported: x64, arm64)."; return 1 ;; esac
    export PATH="$HOME/.local/share/moe/node/current/bin:$HOME/.local/share/moe/npm/bin:$PATH"
    local missing=() tool required=(git python3 curl tar)
    if [ "$os_name" = Linux ]; then required+=(tmux); fi
    for tool in "${required[@]}"; do
        moe_has_tool "$tool" || missing+=("$tool")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        # CA roots are required before downloading official Node distributions.
        moe_package_install "$os_name" "${missing[@]}" ca-certificates || return
        for tool in "${required[@]}"; do
            moe_has_tool "$tool" || { moe_dependency_error "$tool is still unavailable after dependency installation."; return 1; }
        done
    fi
    if ! moe_node_ready || ! moe_has_tool npm; then
        moe_install_node "$node_os" "$node_arch" || return
        hash -r
        moe_node_ready && moe_has_tool npm || { moe_dependency_error 'Installed Node.js/npm could not run on this system.'; return 1; }
    fi
    if [ "$with_plugin" = true ] && ! moe_select_java17; then
        if [ "$os_name" = Darwin ]; then
            moe_package_install "$os_name" openjdk@17 || return
            local brew_java
            brew_java=$(brew --prefix openjdk@17) || return
            export JAVA_HOME="$brew_java/libexec/openjdk.jdk/Contents/Home"
            export PATH="$JAVA_HOME/bin:$PATH"
        else
            moe_package_install "$os_name" openjdk-17-jdk || return
        fi
        moe_select_java17 || { moe_dependency_error 'JDK 17 is still unavailable after installation.'; return 1; }
    fi
    if [ "$agent" != none ] && ! moe_has_tool "$agent"; then
        local package
        case "$agent" in claude) package=@anthropic-ai/claude-code ;; codex) package=@openai/codex ;; gemini) package=@google/gemini-cli ;; esac
        npm install --global --prefix "$HOME/.local/share/moe/npm" "$package" || return
        hash -r
        moe_has_tool "$agent" || { moe_dependency_error "$agent is still unavailable after installation."; return 1; }
    fi
    # Keep the user's npm configuration intact. Only this installer uses a user prefix
    # when its current global prefix is unwritable (or Node was installed by Moe).
    local prefix
    prefix=$(npm prefix -g) || return
    if [ ! -w "$prefix" ] || [[ "$(command -v node)" == "$HOME/.local/share/moe/"* ]]; then
        export npm_config_prefix="$HOME/.local/share/moe/npm"
    fi
    moe_persist_environment || return
    printf '[OK] Node.js, npm, Git, Python3, curl and tar are ready.\n'
    if [ "$agent" != none ]; then
        printf '[OK] %s is installed. Run %s once to sign in before launching a Moe agent.\n' "$agent" "$agent"
    fi
}
