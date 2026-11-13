FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    INTERNAL_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.INTERNAL_PORT || '8090') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/main.js"]
CMD ["serve"]
