ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG FOUNDRY_VERSION=1.5.1
RUN set -eu; \
    npm install --prefix /opt/foundry --no-audit --no-fund \
      "@foundry-rs/forge@${FOUNDRY_VERSION}" "@foundry-rs/anvil@${FOUNDRY_VERSION}"; \
    arch="$(node -p 'process.arch === "x64" ? "amd64" : process.arch')"; \
    for tool in forge anvil; do \
      install "/opt/foundry/node_modules/@foundry-rs/${tool}-linux-${arch}/bin/${tool}" "/usr/local/bin/${tool}"; \
    done; \
    rm -rf /opt/foundry; \
    install -d -o node -g node /app

WORKDIR /app
COPY --chown=node:node . .
USER node
RUN npm ci --no-audit --no-fund && forge build && node scripts/update-runtime.mjs --check
ENV WEB_HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "scripts/local-demo.mjs", "--serve"]
