FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
RUN npm ci
COPY . .
RUN npm run build

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production MOKIE_DB_PATH=/data/mokie.db
COPY --from=build /app /app
VOLUME /data
EXPOSE 8080
CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
