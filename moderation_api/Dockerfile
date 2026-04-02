FROM python:3.11-slim

LABEL maintainer="SETRAF Center"
LABEL description="Moderation API — sentence-transformers/all-MiniLM-L6-v2"

WORKDIR /app

# Dépendances système minimales pour torch + sentence-transformers
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Installer les dépendances Python en premier (cache Docker)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir --timeout 300 -r requirements.txt

# Copier le code de l'API
COPY main.py .

# ── Variables d'environnement ──────────────────────────────────────────────
# Le modèle est monté en volume depuis l'hôte (voir docker-compose)
ENV MINILM_MODEL_PATH=/models/minilm
ENV MODEL_CACHE_DIR=/models
ENV MODERATION_PORT=8001

# Répertoire des modèles (monté en volume)
VOLUME ["/models"]

EXPOSE 8001

# Healthcheck via l'endpoint /health
HEALTHCHECK --interval=30s --timeout=15s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--log-level", "info"]
