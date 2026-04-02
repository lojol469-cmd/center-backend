# Dockerfile pour Backend Node.js CENTER
FROM node:18-alpine

LABEL maintainer="BelikanM"
LABEL description="Backend Node.js pour CENTER - API REST avec MongoDB"

ENV NODE_ENV=production \
    PORT=5000

WORKDIR /app

COPY package*.json ./

# wget est inclus dans busybox d'Alpine, pas besoin de l'installer
RUN npm install --omit=dev && \
    npm cache clean --force

COPY server.js ./
COPY cloudynary.js ./
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY controllers/ ./controllers/
COPY models/ ./models/

RUN mkdir -p uploads storage/temp

EXPOSE 5000

# Healthcheck via wget (natif Alpine/busybox)
HEALTHCHECK --interval=20s --timeout=10s --start-period=30s --retries=5 \
    CMD wget -qO- http://127.0.0.1:5000/api/server-info || exit 1

CMD ["node", "server.js"]

