#!/bin/sh
set -e

# Create HLS and recordings directories if missing
mkdir -p /tmp/hls /recordings

# Give full write access to every process (workers run as nobody inside Docker)
chmod -R 777 /tmp/hls /recordings || true

# Best-effort chown to nobody (typical nginx worker user)
chown -R nobody:nobody /tmp/hls /recordings 2>/dev/null || \
  chown -R root:root   /tmp/hls /recordings 2>/dev/null || true

# Start nginx in foreground
exec nginx -g 'daemon off;'
