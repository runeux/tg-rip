FROM oven/bun:1.4.0
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY dist/ ./dist/
USER bun
CMD ["bun", "dist/index.js"]
