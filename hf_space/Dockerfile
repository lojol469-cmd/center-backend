FROM python:3.11-slim

WORKDIR /app

# Dépendances système pour bitsandbytes, faiss-cpu, PyMuPDF
RUN apt-get update && apt-get install -y \
    libgomp1 \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copier et installer les dépendances Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copier le code source
COPY app.py unified_agent.py ./

# Dossiers de travail (chat memory temporaire)
RUN mkdir -p /app/storage/chat_memory /tmp/uploads

# Variables d'environnement par défaut
ENV PYTHONUNBUFFERED=1
ENV SMOLVLM_MODEL_ID=HuggingFaceTB/SmolVLM-256M-Instruct
ENV MINILM_MODEL_ID=sentence-transformers/all-MiniLM-L6-v2
ENV HF_HUB_ENABLE_HF_TRANSFER=0
ENV TRANSFORMERS_CACHE=/tmp/hf_cache
ENV HF_HOME=/tmp/hf_home

# Port HuggingFace Spaces
EXPOSE 7860

# Healthcheck
HEALTHCHECK --interval=30s --timeout=20s --start-period=120s \
  CMD curl -f http://localhost:7860/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--log-level", "info"]
