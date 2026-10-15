FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
# Build-time knobs for low-memory hosts (these do not leak into the runtime stage).
#   NODE_BUILD_MEMORY  V8 old-space cap (MB). Lowering it makes V8 collect earlier
#                      instead of growing until the kernel OOM-kills the build.
#   SKIP_TYPECHECK     Skip `tsc --noEmit`, the single largest memory consumer.
#                      Type checking still runs in CI (.github/workflows).
ARG NODE_BUILD_MEMORY=768
ARG SKIP_TYPECHECK=false
ENV NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_MEMORY}"
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN if [ "$SKIP_TYPECHECK" = "true" ]; then npx vite build; else npm run build; fi


FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3210 EASYX_DATA_DIR=/data EASYX_MEDIA_DIR=/media EASYX_EXTERNAL_PLUGINS_DIR=/plugins \
    EASYX_EMBEDDED_SUBTITLE_WORKER=false EASYX_SUBTITLE_PYTHON=/opt/subtitles/bin/python \
    EASYX_WHISPER_MODEL=small EASYX_TRANSLATION_MODEL=facebook/nllb-200-distilled-600M EASYX_SUBTITLE_CHUNK_SECONDS=600 \
    HF_HOME=/data/subtitle-models/huggingface PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false
ENV PATH=/opt/easyx/bin:/opt/ofscraper/bin:$PATH
WORKDIR /app
# ofscraper 3.14.7 pins idna==3.7 and lxml~=5.1, which have known CVEs
# (CVE-2026-45409, CVE-2026-41066); the fixed versions are installed over them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg libimage-exiftool-perl novnc openbox python3 python3-venv python3-dev tini websockify x11vnc xvfb gcc g++ \
    && python3 -m venv /opt/easyx \
    && /opt/easyx/bin/pip install --no-cache-dir --upgrade pip "yt-dlp[default,curl-cffi]" gallery-dl \
    && python3 -m venv /opt/ofscraper \
    && /opt/ofscraper/bin/pip install --no-cache-dir --upgrade pip "ofscraper==3.14.7" \
    && /opt/ofscraper/bin/pip install --no-cache-dir "idna==3.20" "lxml==6.1.3" \
    && python3 -m venv /opt/subtitles \
    && /opt/subtitles/bin/pip install --no-cache-dir --upgrade pip \
    && apt-get purge -y --auto-remove python3-dev gcc g++ \
    && rm -rf /var/lib/apt/lists/*
COPY requirements-subtitles.txt ./
RUN /opt/subtitles/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch==2.9.1 \
    && /opt/subtitles/bin/pip install -r requirements-subtitles.txt
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server ./server
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/packages ./packages
COPY --from=build /app/dist ./dist
COPY worker ./worker
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
COPY scripts/easyx-ofscraper-download.mjs /usr/local/bin/easyx-ofscraper-download
COPY scripts/easyx-ofscraper-auth-test.py /usr/local/bin/easyx-ofscraper-auth-test
COPY scripts/easyx-browser-fetch.py /usr/local/bin/easyx-browser-fetch
COPY scripts/easyx-x-scrape.py /usr/local/bin/easyx-x-scrape
RUN chmod 0755 /app/docker-entrypoint.sh /usr/local/bin/easyx-ofscraper-download /usr/local/bin/easyx-ofscraper-auth-test /usr/local/bin/easyx-browser-fetch /usr/local/bin/easyx-x-scrape && mkdir -p /data /media /plugins
# Release metadata must not invalidate dependency installation layers.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
EXPOSE 3210
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
