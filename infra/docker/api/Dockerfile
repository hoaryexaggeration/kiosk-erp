# Multi-stage build for the kiosk-erp API (used by docker-compose `api` profile).
FROM node:22-alpine AS build
WORKDIR /app
COPY apps/api/package.json ./
RUN npm install
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json ./
COPY apps/api/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY apps/api/package.json ./
# .sql migrations are not emitted by tsc; copy them next to the compiled runner.
COPY apps/api/src/db/migrations ./dist/db/migrations
EXPOSE 3000
CMD ["node", "dist/main.js"]
