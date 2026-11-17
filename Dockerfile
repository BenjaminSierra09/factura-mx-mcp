FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    PORT=8787 \
    CHROMIUM_SANDBOX=true

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build \
    && npm prune --omit=dev \
    && npx playwright install --with-deps chromium \
    && mkdir -p /app/data \
    && chown -R node:node /app /ms-playwright

USER node
EXPOSE 8787
CMD ["node", "dist/src/server.js"]
