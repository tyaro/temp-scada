#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-env.sh
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw Error("Node >=24 required")'
mkdir -p /workspace/.toolchains /workspace/.cache/npm
if ! test -x /workspace/.toolchains/pnpm/node_modules/.bin/pnpm || [[ "$(pnpm --version)" != 10.33.0 ]]; then
  npm install --prefix /workspace/.toolchains/pnpm pnpm@10.33.0 --no-audit --no-fund
fi
if ! command -v rustup >/dev/null; then
  [[ "$(uname -sm)" == "Linux x86_64" ]] || { echo 'Cloud bootstrap requires Linux x86_64' >&2; exit 1; }
  scada_bootstrap=$(mktemp -d /tmp/scada-rustup.XXXXXX)
  trap 'rm -rf "$scada_bootstrap"' EXIT
  curl --fail --location --retry 2 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o "$scada_bootstrap/rustup-init"
  curl --fail --location --retry 2 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256 -o "$scada_bootstrap/rustup-init.sha256"
  (cd "$scada_bootstrap" && sha256sum --check rustup-init.sha256)
  chmod +x "$scada_bootstrap/rustup-init"
  "$scada_bootstrap/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.98.1 --component rustfmt --component clippy
fi
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy
pnpm install --frozen-lockfile --store-dir /workspace/.cache/pnpm
cargo fetch --locked
if [[ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ]]; then
  pnpm exec playwright install chromium
fi
