FROM denoland/deno:bin-2.5.6 AS deno
FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

FROM oven/bun:1.4.0
WORKDIR /app
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3-venv \
    && python3 -m venv /opt/downloaders \
    && /opt/downloaders/bin/pip install --no-cache-dir \
        'yt-dlp[default,curl-cffi]==2026.10.26' 'gallery-dl==1.32.19' \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/downloaders/bin:${PATH}"
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY dist/ ./dist/
USER bun
CMD ["bun", "dist/index.js"]
