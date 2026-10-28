# Build only on an authorized host, then review and pin the resulting image.
# Supply a reviewed immutable Python 3.12+ Debian Bookworm base digest.
# No application code, credentials or host configuration belong in this image.
# https://playwright.dev/python/docs/docker#build-your-own-image
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN /usr/local/bin/python3 -I -S -c "import sys; assert sys.version_info >= (3, 12)" \
    && /usr/local/bin/python3 -m pip install --no-cache-dir playwright==1.63.0 \
    && /usr/local/bin/python3 -m playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin researcher

LABEL newscraft.browser.contract="v1" \
      newscraft.playwright="1.63.0" \
      newscraft.chromium="installed"

# Only the capability-free namespace watchdog runs as UID 0. The RPC process
# and Chromium use UID 1000 with Chromium's own sandbox required. The runtime
# supplies the reviewed deny-by-default seccomp profile; this image installs no
# policy and never grants host IPC, SYS_ADMIN, privileged mode or host mounts.
USER 0:0
WORKDIR /
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/python3"]
