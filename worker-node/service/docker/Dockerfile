FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --onnxruntime-node-install-cuda=skip onnxruntime-node@1.20.1 && npm cache clean --force
COPY public ./public
COPY worker.mjs ./worker.mjs
ENV APP_ROOT=/app CP_DATA_ROOT=/data FFMPEG_PATH=/usr/bin/ffmpeg PYTHON=python3 NODE_OPTIONS=--max-old-space-size=6144
CMD ["node", "worker.mjs"]
