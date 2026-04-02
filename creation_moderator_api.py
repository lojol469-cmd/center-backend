"""
SETRAF Center — Content Moderation & Promotion API
FastAPI service using sentence-transformers/all-MiniLM-L6-v2 (local)
Port: 8001
"""

import os
import sys
import numpy as np  # type: ignore[import]
import uvicorn  # type: ignore[import]
from fastapi import FastAPI, HTTPException  # type: ignore[import]
from fastapi.middleware.cors import CORSMiddleware  # type: ignore[import]
from pydantic import BaseModel  # type: ignore[import]
from typing import Optional, List
from dotenv import load_dotenv  # type: ignore[import]

# ── Charger le .env du backend parent ──────────────────────────────────────────
_env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(_env_path)

# ── Chemin vers le modèle local ────────────────────────────────────────────────
_MODEL_DIR = os.getenv(
    "MINILM_MODEL_PATH",
    os.path.join(
        os.path.dirname(__file__),
        "..",
        "frontend-center",
        "models--sentence-transformers--all-MiniLM-L6-v2",
        "snapshots",
        "c9745ed1d9f207416be6d2e6f8de32d1f16199bf",
    ),
)

print(f"[MODERATION] Chargement du modèle depuis : {_MODEL_DIR}")

try:
    from sentence_transformers import SentenceTransformer  # type: ignore[import]
    _model = SentenceTransformer(_MODEL_DIR)
    print("[MODERATION] ✅ Modèle MiniLM chargé avec succès")
except Exception as e:
    print(f"[MODERATION] ❌ Erreur chargement modèle : {e}")
    _model = None

# ── App FastAPI ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="SETRAF Content Moderation API",
    version="1.0.0",
    description="Modération de contenu & scoring de promotion (MiniLM-L6-v2)",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Références sémantiques ─────────────────────────────────────────────────────
_TOXIC_REFS = [
    "violence and gore",
    "hate speech racism discrimination",
    "sexual explicit adult content pornography",
    "terrorism extremism radicalization",
    "harassment bullying threats intimidation",
    "drug abuse illegal substances",
    "self harm suicide encouragement",
    "child exploitation abuse",
    "spam scam fraud misinformation",
    "doxxing personal information leak",
]

_QUALITY_REFS = [
    "informative educational learning",
    "professional work achievement",
    "community support helping others",
    "creative innovation inspiration",
    "positive uplifting motivating",
    "news update information sharing",
    "humor entertainment wholesome",
    "sports fitness health wellness",
    "art culture literature",
    "science technology discovery",
]

_BOOST_REFS = [
    "breaking news urgent important",
    "exclusive first reveal announcement",
    "viral trending popular",
    "celebration achievement milestone",
    "event happening live",
]

# Pré-calculer les embeddings de référence au démarrage
_toxic_embeddings: Optional[np.ndarray] = None
_quality_embeddings: Optional[np.ndarray] = None
_boost_embeddings: Optional[np.ndarray] = None

if _model is not None:
    _toxic_embeddings = _model.encode(_TOXIC_REFS, normalize_embeddings=True)
    _quality_embeddings = _model.encode(_QUALITY_REFS, normalize_embeddings=True)
    _boost_embeddings = _model.encode(_BOOST_REFS, normalize_embeddings=True)
    print("[MODERATION] ✅ Embeddings de référence calculés")


# ── Modèles Pydantic ───────────────────────────────────────────────────────────
class ContentRequest(BaseModel):
    text: str
    image_url: Optional[str] = None
    video_url: Optional[str] = None
    author_reputation: float = 0.5  # 0–1, réputation de l'auteur
    previous_engagement_rate: float = 0.0  # taux d'engagement moyen passé


class ContentResponse(BaseModel):
    is_appropriate: bool
    toxicity_score: float        # 0 = sûr, 1 = toxique
    quality_score: float         # 0 = mauvais, 1 = excellent
    promotion_score: float       # 0–1, score algorithme promotion
    action: str                  # PROMOTE | BOOST | NORMAL | REVIEW | REJECT
    reason: str
    recommendations: List[str]
    boost_eligibility: bool


class BatchRequest(BaseModel):
    contents: List[ContentRequest]


# ── Helpers ────────────────────────────────────────────────────────────────────
def _cosine_sim(a: np.ndarray, refs: np.ndarray) -> np.ndarray:
    """Similarité cosinus entre un vecteur a et une matrice refs (normalisés)."""
    return refs @ a  # refs est déjà normalisé, a aussi si normalize=True


def _analyze(req: ContentRequest):
    if _model is None or _toxic_embeddings is None:
        raise HTTPException(503, "Modèle non disponible")

    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Contenu vide")

    # Embedding du contenu (normalisé)
    emb = _model.encode([text], normalize_embeddings=True)[0]

    # ── Toxicité ──────────────────────────────────────────────────────────────
    toxic_sims = _cosine_sim(emb, _toxic_embeddings)
    toxicity_score = float(np.max(toxic_sims))

    # ── Qualité ───────────────────────────────────────────────────────────────
    quality_sims = _cosine_sim(emb, _quality_embeddings)
    quality_score = float(np.mean(np.clip(quality_sims, 0, 1)))

    # ── Boost potential ───────────────────────────────────────────────────────
    boost_sims = _cosine_sim(emb, _boost_embeddings)
    boost_potential = float(np.max(boost_sims))

    # ── Score de promotion (algorithme multi-facteur) ─────────────────────────
    has_image = 1.0 if req.image_url else 0.0
    has_video = 1.0 if req.video_url else 0.0
    media_bonus = min(has_image * 0.15 + has_video * 0.25, 0.30)

    text_len_score = min(len(text) / 400.0, 1.0)  # cible 400 chars
    word_count = len(text.split())
    readability = min(word_count / 60.0, 1.0)  # cible 60 mots

    # Facteur de réputation de l'auteur
    reputation_bonus = req.author_reputation * 0.10

    # Facteur d'engagement historique
    engagement_bonus = req.previous_engagement_rate * 0.10

    # Score composite (pondération transparente)
    promotion_score = (
        quality_score * 0.35
        + text_len_score * 0.15
        + readability * 0.10
        + media_bonus
        + reputation_bonus
        + engagement_bonus
        + max(0, (1.0 - toxicity_score)) * 0.10  # malus toxicité
    )
    promotion_score = float(np.clip(promotion_score, 0.0, 1.0))

    # ── Décision ──────────────────────────────────────────────────────────────
    recommendations = []
    boost_eligibility = False

    if toxicity_score > 0.55:
        action = "REJECT"
        reason = "Contenu inapproprié ou dangereux détecté"
        is_appropriate = False
        recommendations.append("Supprimez tout contenu violent, haineux ou explicite.")
    elif toxicity_score > 0.35:
        action = "REVIEW"
        reason = "Contenu potentiellement sensible — révision manuelle requise"
        is_appropriate = False
        recommendations.append("Reformulez les passages ambigus pour passer la modération.")
    elif promotion_score > 0.72 and quality_score > 0.45:
        action = "PROMOTE"
        reason = "Contenu de haute qualité — éligible à la promotion gratuite"
        is_appropriate = True
        boost_eligibility = True
    elif boost_potential > 0.50 and promotion_score > 0.55:
        action = "BOOST"
        reason = "Contenu viral potentiel — boost recommandé"
        is_appropriate = True
        boost_eligibility = True
    else:
        action = "NORMAL"
        reason = "Contenu standard publié normalement"
        is_appropriate = True

    # Recommandations d'amélioration
    if len(text) < 80:
        recommendations.append("Ajoutez plus de détails (80+ caractères recommandés).")
    if not req.image_url and not req.video_url:
        recommendations.append("Ajoutez une image ou une vidéo (+40% de visibilité).")
    if quality_score < 0.30:
        recommendations.append("Rendez le contenu plus informatif ou engageant.")
    if word_count < 15:
        recommendations.append("Développez votre message pour impliquer davantage votre audience.")

    return dict(
        is_appropriate=is_appropriate,
        toxicity_score=round(toxicity_score, 4),
        quality_score=round(quality_score, 4),
        promotion_score=round(promotion_score, 4),
        action=action,
        reason=reason,
        recommendations=recommendations,
        boost_eligibility=boost_eligibility,
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    return {
        "service": "SETRAF Content Moderation",
        "model": "all-MiniLM-L6-v2",
        "version": "1.0.0",
        "model_loaded": _model is not None,
    }


@app.get("/health")
async def health():
    return {
        "status": "ok" if _model is not None else "degraded",
        "model_loaded": _model is not None,
    }


@app.post("/moderate", response_model=ContentResponse)
async def moderate(req: ContentRequest):
    """
    Analyse un contenu texte (+ optionnel image/video).
    Retourne : toxicité, qualité, score de promotion, action recommandée.
    """
    result = _analyze(req)
    return ContentResponse(**result)


@app.post("/moderate/batch")
async def moderate_batch(req: BatchRequest):
    """Analyse plusieurs contenus en une seule requête."""
    results = []
    for item in req.contents:
        try:
            results.append(_analyze(item))
        except Exception as e:
            results.append({"error": str(e)})
    return {"results": results}


@app.post("/score/promotion")
async def score_promotion(req: ContentRequest):
    """Retourne uniquement le score de promotion (plus léger)."""
    result = _analyze(req)
    return {
        "promotion_score": result["promotion_score"],
        "action": result["action"],
        "boost_eligibility": result["boost_eligibility"],
    }


if __name__ == "__main__":
    port = int(os.getenv("MODERATION_PORT", "8001"))
    uvicorn.run("creation_moderator_api:app", host="0.0.0.0", port=port, reload=False)
