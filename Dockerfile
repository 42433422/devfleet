FROM node:20-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV DEVFLEET_DB_FILE=/data/db.json
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY api ./api
EXPOSE 3001
VOLUME ["/data"]
CMD ["node", "--import", "tsx", "api/server.ts"]
