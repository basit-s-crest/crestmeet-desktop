"""Local embedding generator using pinned ONNX models."""

from typing import List, Tuple
from fastembed import TextEmbedding

# Model identifier pinned per specification
DEFAULT_MODEL_NAME = "BAAI/bge-small-en-v1.5"
MODEL_TAG = "bge-small-en-v1.5@1"
EMBEDDING_DIMENSION = 384


class LocalEmbedder:
    """
    Pinned local embedding generator using FastEmbed (ONNX Runtime).
    Default model: BAAI/bge-small-en-v1.5 producing 384-dimensional normalized vectors.
    """

    def __init__(self, model_name: str = DEFAULT_MODEL_NAME):
        self.model_name = model_name
        self.model_tag = MODEL_TAG
        self.dimension = EMBEDDING_DIMENSION
        self._model: TextEmbedding | None = None

    def _get_model(self) -> TextEmbedding:
        if self._model is None:
            self._model = TextEmbedding(model_name=self.model_name)
        return self._model

    def embed_texts(self, texts: List[str]) -> Tuple[str, int, List[List[float]]]:
        """
        Embed a batch of text strings.
        Returns: (model_tag, dimension, list of embedding vectors)
        """
        if not texts:
            return self.model_tag, self.dimension, []

        model = self._get_model()
        # FastEmbed returns an iterator of numpy ndarrays
        embeddings_iter = model.embed(texts)
        embeddings = [vec.tolist() for vec in embeddings_iter]

        return self.model_tag, self.dimension, embeddings

    def embed_query(self, query: str) -> List[float]:
        """Embed a single search query."""
        _, _, vectors = self.embed_texts([query])
        return vectors[0] if vectors else [0.0] * self.dimension
