ARG NODE_IMAGE=node:24.22.3-alpine3.24@sha256:d8d97e479cdc64f052f81f129362168717c59783ade8dcc1abd22e1cca8dbd7c

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    INTERNAL_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
# The internal port is not published: no EXPOSE on purpose.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.INTERNAL_PORT || '8090') + '/healthz').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }, (e) => { console.log(String(e)); process.exit(1); })"]
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
CMD ["serve"]
