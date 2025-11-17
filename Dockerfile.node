# Dockerfile pour Backend Node.js (Render)
FROM node:18-alpine

# Informations
LABEL maintainer="BelikanM"
LABEL description="Backend Node.js pour CENTER - API REST avec MongoDB"

# Variables d'environnement
ENV NODE_ENV=production \
    PORT=5000

# Créer le répertoire de travail
WORKDIR /app

# Copier les fichiers package
COPY package*.json ./

# Installer les dépendances en production
RUN npm ci --only=production && \
    npm cache clean --force

# Copier le code source (uniquement Node.js)
COPY server.js ./
COPY routes/ ./routes/
COPY controllers/ ./controllers/
COPY services/ ./services/

# Créer les dossiers nécessaires
RUN mkdir -p uploads storage/temp

# Exposer le port
EXPOSE 5000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:5000/api/server-info', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Commande de démarrage
CMD ["node", "server.js"]
