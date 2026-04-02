"""
food_recommend_api.py
─────────────────────
Microservice FastAPI pour les recommandations de restaurants/plats
en utilisant le modèle sentence-transformers/all-MiniLM-L6-v2.

Architecture :
  1. Au démarrage : encode tous les restaurants (name + category + description)
  2. GET /recommend/restaurants?userId=X&limit=10
     → cherche l'historique de commandes de l'utilisateur
     → trouve les K restaurants les plus similaires (cosine similarity)
  3. GET /recommend/search?q=texte
     → semantic search dans le catalogue de plats/restaurants

Variables d'environnement :
  MINILM_MODEL_PATH   – chemin vers le dossier du modèle (défaut: ./models/all-MiniLM-L6-v2)
  MONGO_URI           – URI vers MongoDB
  PORT                – port d'écoute (défaut: 8003)
"""

import os
import asyncio
import time
from typing import Any, Dict, List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
from pymongo import MongoClient
from bson import ObjectId
import uvicorn

# ── Config ─────────────────────────────────────────────────────────────────
MODEL_PATH  = os.getenv(
    'MINILM_MODEL_PATH',
    os.path.join(os.path.dirname(__file__), '..', 'frontend-center', 'models--sentence-transformers--all-MiniLM-L6-v2')
)
MONGO_URI   = os.getenv('MONGO_URI', 'mongodb://127.0.0.1:27017/myDatabase60')
PORT        = int(os.getenv('PORT_RECOMMEND', '8003'))

# ── Global state ────────────────────────────────────────────────────────────
model:           Optional[SentenceTransformer] = None
mongo_client:    Optional[MongoClient]         = None
db:              Any                           = None
restaurant_index: Dict[str, Any]              = {}   # restaurantId → {embedding, meta}
last_indexed_at: float                        = 0.0

INDEX_REFRESH_SECONDS = 300   # re-indexer toutes les 5 minutes

# ── Helpers ─────────────────────────────────────────────────────────────────

def get_restaurant_text(r: dict) -> str:
    """Concatène les champs textuels d'un restaurant pour l'encodage."""
    parts = [
        r.get('name', ''),
        r.get('category', ''),
        r.get('description', ''),
    ]
    # Ajouter les noms des items du menu
    for item in r.get('menu', [])[:10]:
        parts.append(item.get('name', ''))
        parts.append(item.get('category', ''))
    return ' | '.join(p for p in parts if p)


def build_index():
    """Encode tous les restaurants actifs et stocke les vecteurs en mémoire."""
    global restaurant_index, last_indexed_at
    try:
        cursor = db.restaurants.find(
            {'isOpen': True},
            {'_id': 1, 'name': 1, 'category': 1, 'description': 1,
             'menu': 1, 'logoUrl': 1, 'coverUrl': 1, 'rating': 1,
             'isLive': 1, 'liveTitle': 1, 'address': 1}
        )
        restaurants = list(cursor)
        if not restaurants:
            print("⚠️ Aucun restaurant trouvé pour l'indexation")
            return

        texts = [get_restaurant_text(r) for r in restaurants]
        embeddings = model.encode(texts, batch_size=32, show_progress_bar=False)

        new_index = {}
        for r, emb in zip(restaurants, embeddings):
            rid = str(r['_id'])
            new_index[rid] = {
                'embedding': emb,
                'meta': {
                    'id':          rid,
                    'name':        r.get('name', ''),
                    'category':    r.get('category', ''),
                    'description': r.get('description', ''),
                    'logoUrl':     r.get('logoUrl', ''),
                    'coverUrl':    r.get('coverUrl', ''),
                    'rating':      r.get('rating', 0),
                    'isLive':      r.get('isLive', False),
                    'liveTitle':   r.get('liveTitle', ''),
                    'address':     r.get('address', ''),
                },
            }

        restaurant_index = new_index
        last_indexed_at  = time.time()
        print(f"✅ Recommandation index built: {len(new_index)} restaurants")
    except Exception as e:
        print(f"❌ Erreur build_index: {e}")


def maybe_refresh_index():
    if time.time() - last_indexed_at > INDEX_REFRESH_SECONDS:
        build_index()


def get_user_history_embedding(user_id: str) -> Optional[np.ndarray]:
    """
    Cherche les 5 dernières commandes de l'utilisateur,
    encode les restaurants commandés et retourne le vecteur moyen.
    """
    try:
        oid = ObjectId(user_id)
    except Exception:
        return None

    orders = list(db.orders.find(
        {'user': oid, 'status': {'$in': ['delivered', 'confirmed']}},
        {'restaurant': 1}
    ).sort('createdAt', -1).limit(5))

    if not orders:
        return None

    restaurant_ids = [str(o['restaurant']) for o in orders if 'restaurant' in o]
    embeddings = [
        restaurant_index[rid]['embedding']
        for rid in restaurant_ids
        if rid in restaurant_index
    ]
    if not embeddings:
        return None

    return np.mean(embeddings, axis=0)


# ── Lifespan ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, mongo_client, db

    print(f"🚀 Chargement du modèle MiniLM depuis: {MODEL_PATH}")
    model = SentenceTransformer(MODEL_PATH)
    print("✅ Modèle all-MiniLM-L6-v2 chargé")

    mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    db = mongo_client.get_default_database()
    print(f"✅ MongoDB connecté: {MONGO_URI}")

    build_index()

    yield   # application running

    mongo_client.close()
    print("👋 Microservice recommandations arrêté")


# ── App ─────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Food Recommendation API",
    description="Utilise sentence-transformers/all-MiniLM-L6-v2 pour recommander des restaurants",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "indexed_restaurants": len(restaurant_index),
        "model": "all-MiniLM-L6-v2",
    }


@app.get("/recommend/restaurants")
def recommend_restaurants(
    userId: str = Query(..., description="ID MongoDB de l'utilisateur"),
    limit:  int = Query(10,  ge=1, le=50),
):
    """
    Recommande des restaurants basés sur l'historique de l'utilisateur.
    Fallback : top restaurants par rating si pas d'historique.
    """
    maybe_refresh_index()

    if not restaurant_index:
        raise HTTPException(503, "Index non disponible")

    user_emb = get_user_history_embedding(userId)

    all_ids   = list(restaurant_index.keys())
    all_embeddings = np.array([restaurant_index[rid]['embedding'] for rid in all_ids])

    if user_emb is not None:
        scores = cosine_similarity([user_emb], all_embeddings)[0]
        top_indices = np.argsort(scores)[::-1][:limit]
        results = []
        for idx in top_indices:
            rid  = all_ids[idx]
            meta = restaurant_index[rid]['meta']
            results.append({**meta, 'score': float(scores[idx])})
    else:
        # Pas d'historique → tri par rating
        sorted_ids = sorted(
            all_ids,
            key=lambda rid: restaurant_index[rid]['meta'].get('rating', 0),
            reverse=True
        )[:limit]
        results = [
            {**restaurant_index[rid]['meta'], 'score': 1.0}
            for rid in sorted_ids
        ]

    return {'recommendations': results, 'hasHistory': user_emb is not None}


@app.get("/recommend/search")
def semantic_search(
    q:     str = Query(..., min_length=1, description="Texte de recherche"),
    limit: int = Query(10, ge=1, le=50),
):
    """
    Recherche sémantique dans le catalogue de restaurants.
    Ex: q='nourriture saine sans gluten' trouve les restaurants Healthy.
    """
    maybe_refresh_index()

    if not restaurant_index:
        raise HTTPException(503, "Index non disponible")

    query_emb = model.encode([q])
    all_ids   = list(restaurant_index.keys())
    all_embeddings = np.array([restaurant_index[rid]['embedding'] for rid in all_ids])
    scores    = cosine_similarity(query_emb, all_embeddings)[0]

    top_indices = np.argsort(scores)[::-1][:limit]
    results = []
    for idx in top_indices:
        if scores[idx] < 0.15:   # seuil minimum de pertinence
            break
        rid  = all_ids[idx]
        meta = restaurant_index[rid]['meta']
        results.append({**meta, 'score': float(scores[idx])})

    return {'results': results, 'query': q}


@app.post("/recommend/refresh-index")
def refresh_index():
    """Force une re-indexation de tous les restaurants."""
    build_index()
    return {'indexed': len(restaurant_index)}


# ── Entry point ─────────────────────────────────────────────────────────────
if __name__ == '__main__':
    uvicorn.run("food_recommend_api:app", host="0.0.0.0", port=PORT, reload=False)
