FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV NODE_ENV=production
ENV KHAOYU_SERVICE_HOST=0.0.0.0
ENV KHAOYU_SERVICE_FRONTEND_PORT=18080
ENV KHAOYU_SERVICE_BACKEND_PORT=18081
ENV KHAOYU_SERVICE_DATA_DIR=/data

EXPOSE 18080 18081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node src/cli.mjs migrate && exec node src/server.mjs"]
