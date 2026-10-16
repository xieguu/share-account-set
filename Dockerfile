FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright RELAY_HOST=0.0.0.0 RELAY_PORT=3410 RELAY_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
RUN npx playwright install --with-deps chromium && mkdir -p /app/data && chown -R node:node /app /ms-playwright
COPY public ./public
USER node
EXPOSE 3410
CMD ["node", "dist/index.js"]
