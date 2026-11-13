FROM node:24-bookworm-slim

WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=8787 \
    TOURNAMENT_SERVER=1 \
    TOURNAMENT_DATA_DIR=/app/runtime

COPY server.mjs hud-data.mjs steam-avatars.mjs tournament-control.mjs observer-bridge.mjs ./
COPY dist/ ./dist/
COPY obs/ ./obs/

RUN install -d -m 0700 -o node -g node /app/runtime

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/state', {signal: AbortSignal.timeout(4000)}).then(response => { if (!response.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });"]

CMD ["node", "server.mjs"]
