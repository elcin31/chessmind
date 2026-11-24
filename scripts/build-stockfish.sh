#!/usr/bin/env bash
set -euo pipefail

ndk=$(cd "$1" && pwd)
output=$2
root=$(cd "$(dirname "$0")/.." && pwd)
work="$(dirname "$output")/engine"
archive="$root/third_party/Stockfish-17.1.tar.gz"
printf '%s  %s\n' 0cfd9396438798cc68f5c0d5fa0bb458bb8ffff7de06add841aaeace86bec1f1 "$archive" | sha256sum -c -
mkdir -p "$work"
tar --strip-components=1 -xzf "$archive" -C "$work"

fetch_network() {
    local name=$1 digest=$2 path="$work/src/$1"
    if ! printf '%s  %s\n' "$digest" "$path" | sha256sum -c --status 2>/dev/null; then
        if [[ -n "${STOCKFISH_NETWORK_DIR:-}" ]]; then
            cp "$STOCKFISH_NETWORK_DIR/$name" "$path.tmp"
        else
            curl -fLSs --retry 3 "https://tests.stockfishchess.org/api/nn/$name" -o "$path.tmp"
        fi
        printf '%s  %s\n' "$digest" "$path.tmp" | sha256sum -c -
        mv "$path.tmp" "$path"
    fi
}
fetch_network nn-1c0000000000.nnue 1c0000000000a67d629999d932d0c373f7450ce43cd12d0562868f4eaf9ae2ad
fetch_network nn-37f18f62d772.nnue 37f18f62d772f3107e1d6aaca3898c130c3c86f2ab63e6555fbbca20635a899d

export PATH="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH"
for abi in arm64-v8a x86_64; do
    arch=x86-64
    if [[ "$abi" = arm64-v8a ]]; then arch=armv8; fi
    make -C "$work/src" objclean ARCH="$arch" COMP=ndk
    make -C "$work/src" -j "${STOCKFISH_JOBS:-2}" build ARCH="$arch" COMP=ndk \
        EXTRALDFLAGS="-Wl,-z,max-page-size=16384"
    mkdir -p "$output/$abi"
    llvm-strip -o "$output/$abi/libstockfish.so" "$work/src/stockfish"
done
