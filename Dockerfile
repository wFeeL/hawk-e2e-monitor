# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV INTERNAL_HOST=0.0.0.0 \
    RECEIVER_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node
# The internal port is not published: no EXPOSE on purpose.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.INTERNAL_PORT || '8090') + '/healthz').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }, (e) => { console.log(String(e)); process.exit(1); })"]
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
CMD ["serve"]
