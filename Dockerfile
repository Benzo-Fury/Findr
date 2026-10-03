# Findr's container image: the compiled Linux executable plus the tools its
# pipeline and VPN killswitch run (mkvmerge, ffmpeg, ip).
#
# It packages executables that are already built rather than compiling them,
# so the image runs exactly what the release ships. Build them first, then the
# image for the matching platform:
#
#   bun run build --target linux-x64 --target linux-arm64
#   docker buildx build --platform linux/amd64,linux/arm64 -t findr .
#
# The release workflow does the same and pushes ghcr.io/benzo-fury/findr.

FROM debian:trixie-slim

ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends mkvtoolnix ffmpeg iproute2 ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

# Pick the executable built for this platform (Docker's amd64 is Bun's x64)
COPY dist/findr-linux-* /tmp/findr/
RUN case "$TARGETARCH" in \
      amd64) target=x64 ;; \
      arm64) target=arm64 ;; \
      *) echo "Unsupported platform: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && install -m 755 "/tmp/findr/findr-linux-$target" /usr/local/bin/findr \
 && rm -rf /tmp/findr

# State lives in /data: the database, the session secret and an optional .env.
# Run as an unprivileged user by default; compose's `user:` can match the host
# user that owns the library folders instead
RUN useradd --uid 1000 --user-group --no-create-home --home-dir /data findr \
 && mkdir /data && chown findr:findr /data
USER findr
WORKDIR /data
VOLUME /data

# FINDR_CONTAINER makes Findr only announce updates: a new image is pulled
# instead of the executable replacing itself inside a container
ENV NODE_ENV=production \
    DATABASE_PATH=/data/findr.db \
    FINDR_CONTAINER=true

EXPOSE 34571 6881/tcp 6881/udp

# The default port; a different one set under Settings → Access needs PORT here too
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS "http://localhost:${PORT:-34571}/api/health" > /dev/null || exit 1

CMD ["/usr/local/bin/findr"]
