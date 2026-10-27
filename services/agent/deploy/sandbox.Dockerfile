# Build only after operator approval. No application source, service environment,
# Docker credentials or cloud secrets belong in this image.
# Official recipe and pinned browser/package compatibility:
# https://playwright.dev/python/docs/docker#build-your-own-image
FROM python:3.12-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir playwright==1.63.0 \
    && python -m playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && useradd --uid 1000 --create-home --shell /bin/sh researcher \
    && mkdir /workspace \
    && chown researcher:researcher /workspace

LABEL newscraft.sandbox.contract="v1" \
      newscraft.python="3.12" \
      newscraft.playwright="1.63.0" \
      newscraft.chromium="installed"

# The runtime overrides UID:GID with the non-root workspace owner's identity.
# Outer isolation is Docker with no network/caps and a read-only root filesystem.
# Browser JavaScript/resources are enabled through the bounded host relay.
# The container has no network, and Chromium's internal sandbox is explicitly
# required. A separately reviewed namespace/seccomp configuration
# may be needed to run Chromium in the target kernel; no relaxed
# seccomp, privileged mode, SYS_ADMIN, host IPC or host socket is requested here.
USER researcher
WORKDIR /workspace
CMD ["python3", "-c", "import time; time.sleep(86400)"]
