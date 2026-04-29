/**
 * embeddings.js — Stub embedding interface for Basil memory system.
 *
 * Production integration:
 *   Replace `mockEmbed` with a real provider call. Candidates:
 *     - OpenAI:  POST /v1/embeddings, model "text-embedding-3-small" → 1536-dim
 *     - Voyage:  POST https://api.voyageai.com/v1/embeddings           → 1024-dim
 *     - Cohere:  POST https://api.cohere.com/v1/embed                  → 1024-dim
 *     - Local:   ollama nomic-embed-text                               → 768-dim
 *
 *   The interface is provider-agnostic. Swap `mockEmbed` for any async
 *   function(text: string) => Promise<number[]> that returns a unit-normalised
 *   dense vector. Update EMBEDDING_DIM to match.
 *
 * Zero external dependencies in this file. The mock uses a deterministic
 * hash projection so tests are reproducible.
 */

"use strict";

const crypto = require("crypto");

// ── Configuration ─────────────────────────────────────────────────────────────

const EMBEDDING_DIM = 64; // Mock dimension. Real providers use 768–3072.

// ── Mock implementation ───────────────────────────────────────────────────────

/**
 * Deterministic mock embedding: hash the text, then project into EMBEDDING_DIM
 * dimensions using seeded pseudo-random floats. The resulting vector is
 * L2-normalised so cosine similarity is well-defined.
 *
 * NOT semantically meaningful — only useful for testing the pipeline wiring.
 * Two different texts will produce different vectors with low cosine similarity
 * (≈ 0), while identical texts always produce the same vector (similarity = 1).
 */
function mockEmbed(text) {
  // Produce a deterministic seed from the input
  const hash = crypto.createHash("sha256").update(text).digest();

  // Build a EMBEDDING_DIM-length vector using the hash bytes as a PRNG seed
  const vec = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // Read two bytes per dimension for range [-1, 1]
    const byteIndex = (i * 2) % hash.length;
    const hi = hash[byteIndex];
    const lo = hash[(byteIndex + 1) % hash.length];
    vec[i] = ((hi << 8 | lo) / 32767.5) - 1.0;
  }

  return l2normalise(Array.from(vec));
}

// ── Similarity ────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1]. Pre-normalised vectors → this is equivalent
 * to the dot product.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function similarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * embed(text) → number[]
 *
 * Returns a dense vector representation of the input text.
 * The mock is synchronous; the real implementation will be async.
 * Callers should always treat this as potentially async (wrap in Promise.resolve
 * or use await) so the switch to a real provider requires no call-site changes.
 *
 * @param {string} text
 * @returns {number[]}
 */
function embed(text) {
  if (typeof text !== "string" || text.length === 0) {
    return new Array(EMBEDDING_DIM).fill(0);
  }
  // Production: replace with async provider call, e.g.:
  //   return openaiClient.embeddings.create({ model: "text-embedding-3-small", input: text })
  //     .then(r => r.data[0].embedding);
  return mockEmbed(text);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function l2normalise(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

module.exports = { embed, similarity, EMBEDDING_DIM, _mockEmbed: mockEmbed };
