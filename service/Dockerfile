FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV NODE_ENV=production
ENV KHAOYU_SERVICE_HOST=0.0.0.0
ENV KHAOYU_SERVICE_PORT=8080
ENV KHAOYU_SERVICE_DATA_DIR=/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
