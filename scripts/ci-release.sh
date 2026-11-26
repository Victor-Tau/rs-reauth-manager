#!/usr/bin/env bash
set -euo pipefail

version=$(python -c 'import json; print(json.load(open("plugin.json"))["version"])')
if [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
  test "$GITHUB_REF_NAME" = "v$version"
fi
sdk_revision=$(python -c 'import tomllib; print(tomllib.load(open("backend/Cargo.toml", "rb"))["dependencies"]["gateway-plugin-sdk"]["rev"])')

rustup toolchain install 1.99.1 --profile minimal --target x86_64-unknown-linux-gnu
python -m pip install -r requirements-dev.txt ziglang==0.15.2
if ! command -v cargo-zigbuild >/dev/null; then
  cargo +1.99.1 install cargo-zigbuild --locked -j 1
fi
mkdir -p .cache/tools
gh release download v0.20.6 --repo google/go-containerregistry \
  --pattern go-containerregistry_Linux_x86_64.tar.gz --dir .cache/tools --clobber
tar -xzf .cache/tools/go-containerregistry_Linux_x86_64.tar.gz -C .cache/tools crane

pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
python scripts/prepare_runtime.py --crane "$PWD/.cache/tools/crane"
python scripts/build_runtime.py
cargo +1.99.1 zigbuild -j 1 --manifest-path backend/Cargo.toml --release --locked --target x86_64-unknown-linux-gnu.2.28

git init .cache/cpr
git -C .cache/cpr remote add origin https://github.com/zyycn/codex-proxy-rs.git
git -C .cache/cpr fetch --depth 1 origin "$sdk_revision"
git -C .cache/cpr checkout --detach FETCH_HEAD
CARGO_TARGET_DIR="$PWD/.cache/cpr-target" cargo +1.99.1 build -j 1 \
  --manifest-path .cache/cpr/backend/Cargo.toml -p codex-proxy-plugin-cli --release --locked
.cache/cpr-target/release/cpr-plugin package --manifest plugin.json \
  --binary backend/target/x86_64-unknown-linux-gnu/release/reauth-manager \
  --target x86_64-unknown-linux-gnu --resource-map web=frontend/dist --output-dir dist
python scripts/verify_artifact.py

package="dist/personal.reauth-manager-$version-x86_64-unknown-linux-gnu.tar.gz"
mkdir -p .cache/smoke
tar -xzf "$package" -C .cache/smoke
digest=$(sha256sum "$package" | cut -d ' ' -f 1)
timeout 180 node verification/release-smoke.mjs .cache/smoke "$digest"
python - <<'PY'
from pathlib import Path
notes = Path('release/notes.md').read_text()
Path('.cache/release-notes.md').write_text(notes.split('\n# ', 1)[0])
PY
