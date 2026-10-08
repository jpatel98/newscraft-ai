# A deliberately small, reviewed computer image. Supply an already reviewed
# immutable Python 3.12+ base digest; no floating default or package installation.
# Building/provisioning this image is an operator deployment step, not startup.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
LABEL newscraft.executor.contract="v1"
RUN /usr/local/bin/python3 -I -S -c "import sys; assert sys.version_info >= (3, 12)"
USER 0:0
WORKDIR /workspace
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/python3"]
