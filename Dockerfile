# --- build stage: compile client + server, keep native deps buildable ---
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY server server
COPY client client
RUN npm run build && npm prune --omit=dev

# --- runtime stage: slim, non-root, no toolchain ---
FROM node:22-alpine
ENV NODE_ENV=production
ENV DB_PATH=/data/expense.db
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/data server/data
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
