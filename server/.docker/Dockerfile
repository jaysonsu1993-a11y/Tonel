# Cross-compile mixer/signaling for prod (Debian 12 / glibc 2.36 / x86_64).
#
# Built once on operator's macOS via `docker buildx build --platform linux/amd64`,
# cached locally. `deploy/server.sh --component=binary` runs a build container
# that mounts the server/ source read-only and writes ELF binaries to
# server/build-linux/, which then rsync to /opt/tonel/bin/ on prod.
#
# Pinned to debian:12 to match prod's glibc + dynamic-linker (verified
# 2026-05-01: `file /opt/tonel/bin/mixer_server` reports "for GNU/Linux 3.2.0,
# dynamically linked, glibc 2.36"). Bumping this tag = re-validate the
# binary still loads on prod.
#
# Pulled via daocloud mirror because direct registry-1.docker.io is
# unreachable from this dev box (CN). Image is cached locally after the
# first build; the mirror string only matters once per dev machine.
FROM docker.m.daocloud.io/library/debian:12

# Swap apt sources to Aliyun mirror — deb.debian.org occasionally returns
# 502 from this network, which fails the apt-get install build step. The
# mirror is also ~10x faster from CN. Affects only build time, not the
# resulting binary. debian:12 uses deb822 format under
# /etc/apt/sources.list.d/debian.sources (not the legacy sources.list).
RUN sed -i \
        -e 's|deb.debian.org/debian-security|mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
        -e 's|deb.debian.org/debian|mirrors.tuna.tsinghua.edu.cn/debian|g' \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        build-essential \
        cmake \
        pkg-config \
        libuv1-dev \
        libopus-dev \
        libssl-dev \
        nlohmann-json3-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Build script lives outside (deploy/server.sh injects it via docker run cmd).
# Output: /out/signaling_server, /out/mixer_server.
