"""
UnifiedAgent Stub — SETRAF Center
==================================
Implémentation minimale permettant à chat_agent_api.py de démarrer
quand le modèle complet n'est pas disponible dans l'environnement Docker.

Pour activer l'agent complet, remplacez ce fichier par l'implémentation
complète avec les modèles LLM, vision et TTS.
"""


class UnifiedAgent:
    """Stub UnifiedAgent — interface compatible avec chat_agent_api.py."""

    def __init__(
        self,
        enable_voice: bool = False,
        enable_vision: bool = False,
        enable_detection: bool = False,
        enable_llm: bool = False,
        **kwargs,
    ):
        self.enable_voice = enable_voice
        self.enable_vision = enable_vision
        self.enable_detection = enable_detection
        self.enable_llm = enable_llm
        print(
            "[UnifiedAgent] ⚠️  Mode stub — modèle complet non disponible. "
            "Replacez models/unified_agent.py par l'implémentation complète."
        )

    def generate(self, prompt: str, **kwargs) -> str:
        """Génération de texte — stub."""
        return (
            "Je suis Kibali, votre assistant SETRAF. "
            "Le modèle IA complet n'est pas chargé dans ce conteneur. "
            "Veuillez configurer l'accès au modèle LLM."
        )

    def describe_image(self, image, **kwargs) -> str:
        """Description d'image — stub."""
        return "Vision non disponible dans ce conteneur Docker."

    def detect_objects(self, image, **kwargs) -> list:
        """Détection d'objets — stub."""
        return []

    def speak(self, text: str, **kwargs) -> bytes:
        """TTS — stub."""
        return b""

    def chat(self, message: str, history: list = None, **kwargs) -> str:
        """Chat — stub avec réponse générique."""
        return self.generate(message)
