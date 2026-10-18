# Source this file in cloud shells; all caches and toolchains stay outside the checkout.
export CARGO_HOME=/workspace/.toolchains/cargo
export RUSTUP_HOME=/workspace/.toolchains/rustup
export XDG_DATA_HOME=/workspace/.local/share
export XDG_CACHE_HOME=/workspace/.cache
export NPM_CONFIG_CACHE=/workspace/.cache/npm
export PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright
export PATH="/workspace/.toolchains/pnpm/node_modules/.bin:$CARGO_HOME/bin:$PATH"
if command -v chromium >/dev/null; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)"
fi
