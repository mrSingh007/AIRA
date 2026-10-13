FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 ca-certificates ripgrep curl make g++ \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgtk-3-0 libgbm1 libasound2 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxkbcommon0 libxshmfence1 fonts-liberation xvfb xauth \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
# Runtime always forces uid 1000, read-only root, and a disposable /tmp filesystem.
USER node
WORKDIR /tmp
CMD ["sleep", "infinity"]
