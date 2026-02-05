# Moe - AI Workforce Command Center
# Homebrew formula for installing moe-daemon and moe-proxy
#
# Install: brew tap yaront1111/moe && brew install moe
# Or directly: brew install yaront1111/moe/moe

class Moe < Formula
  desc "AI Workforce Command Center - daemon and proxy for AI task orchestration"
  homepage "https://github.com/yaront1111/Moe-s-Tavern"
  url "https://github.com/yaront1111/Moe-s-Tavern/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "PLACEHOLDER_SHA256" # Update on release
  license "MIT"
  version "0.1.0"

  depends_on "node@18"

  def install
    # Install moe-daemon
    cd "packages/moe-daemon" do
      system "npm", "ci"
      system "npm", "run", "build"
      libexec.install Dir["*"]
    end

    # Install moe-proxy
    cd "packages/moe-proxy" do
      system "npm", "ci"
      system "npm", "run", "build"
      (libexec/"moe-proxy").install Dir["*"]
    end

    # Create wrapper scripts
    (bin/"moe-daemon").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node@18"].opt_bin}/node" "#{libexec}/dist/index.js" "$@"
    EOS

    (bin/"moe-proxy").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node@18"].opt_bin}/node" "#{libexec}/moe-proxy/dist/index.js" "$@"
    EOS

    # Install scripts
    (prefix/"scripts").install Dir["scripts/*.sh"]
  end

  def post_install
    # Create ~/.moe directory
    moe_dir = Pathname.new(Dir.home) / ".moe"
    moe_dir.mkpath unless moe_dir.exist?

    projects_file = moe_dir / "projects.json"
    projects_file.write("[]") unless projects_file.exist?
  end

  def caveats
    <<~EOS
      Moe has been installed!

      To start the daemon for a project:
        moe-daemon start --project /path/to/your/project

      To run an AI agent:
        #{opt_prefix}/scripts/moe-agent.sh --role worker --project /path/to/project

      For JetBrains IDE integration, install the Moe plugin from:
        https://github.com/yaront1111/Moe-s-Tavern/releases

      Documentation:
        https://github.com/yaront1111/Moe-s-Tavern#readme
    EOS
  end

  test do
    # Test that daemon shows help
    assert_match "moe-daemon", shell_output("#{bin}/moe-daemon --help 2>&1", 0)
  end
end
