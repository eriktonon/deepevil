'use strict';

const crypto = require('node:crypto');
const { request } = require('undici');

const DEFAULT_QDRANT_URLS = [
  'http://127.0.0.1:6333',
  'http://192.168.3.109:6333'
];
const COLLECTION_NAME = 'deepevil_conversations';
const VECTOR_DIM = 384;

/**
 * Gera um vetor determinístico normalizado de 384 dimensões (Cosine) a partir do texto
 * para indexação rápida no Qdrant sem bloquear o loop de eventos.
 */
function textToDeterministicVector(text, dim = VECTOR_DIM) {
  const clean = String(text || '').toLowerCase().trim() || 'deepevil';
  const vec = new Float32Array(dim);
  const tokens = clean.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const hash = crypto.createHash('sha256').update(tokens[i]).digest();
    for (let j = 0; j < dim; j++) {
      const byteVal = hash[j % hash.length];
      vec[j] += ((byteVal / 127.5) - 1.0);
    }
  }

  let norm = 0;
  for (let j = 0; j < dim; j++) {
    norm += vec[j] * vec[j];
  }
  norm = Math.sqrt(norm) || 1;

  return Array.from(vec, (v) => Number((v / norm).toFixed(6)));
}

/**
 * Camada de persistência vetorial e documental no Qdrant Vector DB (6333).
 * Sincroniza cada conversa, turno e fontes extraídas via Readability na coleção
 * `deepevil_conversations`.
 */
function createQdrantStore(options = {}) {
  const env = options.env || process.env;
  const httpRequest = options.requestFn || request;
  const collection = options.collection || env.QDRANT_COLLECTION || COLLECTION_NAME;
  const configuredUrl = String(env.QDRANT_URL || '').trim().replace(/\/+$/, '');
  const candidateUrls = configuredUrl
    ? [configuredUrl, ...DEFAULT_QDRANT_URLS.filter((u) => u !== configuredUrl)]
    : DEFAULT_QDRANT_URLS;

  let activeBaseUrl = candidateUrls[0];
  let collectionInitialized = false;

  async function resolveHealthyUrl() {
    for (const url of candidateUrls) {
      try {
        const res = await httpRequest(`${url}/collections`, {
          method: 'GET',
          headersTimeout: 1500,
          bodyTimeout: 1500
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (res.body && typeof res.body.dump === 'function') {
            await res.body.dump().catch(() => {});
          }
          activeBaseUrl = url;
          return url;
        }
      } catch (_) {
        // Tenta próximo endpoint Qdrant
      }
    }
    return null;
  }

  async function ensureCollection() {
    if (collectionInitialized) return activeBaseUrl;
    const baseUrl = await resolveHealthyUrl();
    if (!baseUrl) return null;

    try {
      const checkRes = await httpRequest(`${baseUrl}/collections/${collection}`, {
        method: 'GET',
        headersTimeout: 2000,
        bodyTimeout: 2000
      });
      if (checkRes.body && typeof checkRes.body.dump === 'function') {
        await checkRes.body.dump().catch(() => {});
      }

      if (checkRes.statusCode === 404) {
        const createRes = await httpRequest(`${baseUrl}/collections/${collection}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vectors: {
              size: VECTOR_DIM,
              distance: 'Cosine'
            }
          }),
          headersTimeout: 3000,
          bodyTimeout: 3000
        });
        if (createRes.body && typeof createRes.body.dump === 'function') {
          await createRes.body.dump().catch(() => {});
        }
      }
      collectionInitialized = true;
      return baseUrl;
    } catch (_) {
      return null;
    }
  }

  return {
    collection,

    async getStatus() {
      const url = await resolveHealthyUrl();
      return {
        online: Boolean(url),
        connected: Boolean(url),
        url: url || candidateUrls[0],
        collection
      };
    },

    async checkHealth() {
      const url = await ensureCollection();
      return {
        online: Boolean(url),
        connected: Boolean(url),
        url: url || candidateUrls[0],
        collection
      };
    },

    async searchKnowledge(query, limit = 8) {
      const baseUrl = await ensureCollection();
      if (!baseUrl || !query) return [];
      const vector = textToDeterministicVector(query);
      try {
        const res = await httpRequest(`${baseUrl}/collections/${collection}/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector,
            limit,
            with_payload: true
          }),
          headersTimeout: 3000,
          bodyTimeout: 3000
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = await res.body.json();
          return Array.isArray(data?.result) ? data.result : [];
        }
        if (res.body && typeof res.body.dump === 'function') {
          await res.body.dump().catch(() => {});
        }
        return [];
      } catch (_) {
        return [];
      }
    },

    /**
     * Indexa um turno completo (pergunta, resposta, modelo e fontes Readability) no Qdrant Vector DB.
     */
    async indexTurn({ conversation, turn, sources = [] }) {
      const baseUrl = await ensureCollection();
      if (!baseUrl || !turn?.id) return false;

      const textForEmbedding = [
        conversation?.title || '',
        turn.question || '',
        turn.answer_markdown || '',
        ...sources.map((s) => `${s.title} ${s.domain}`)
      ].join(' ');

      const vector = textToDeterministicVector(textForEmbedding);
      const pointId = Number(turn.id);

      const payload = {
        conversation_id: Number(conversation?.id || turn.conversation_id),
        conversation_title: String(conversation?.title || turn.question || ''),
        turn_id: pointId,
        question: String(turn.question || ''),
        search_query: String(turn.search_query || ''),
        answer_markdown: String(turn.answer_markdown || ''),
        status: String(turn.status || 'completed'),
        provider: String(turn.provider || ''),
        model: String(turn.model || ''),
        attempted_urls_count: Number(turn.attempted_urls_count || 0),
        extracted_sources_count: Number(turn.extracted_sources_count || sources.length),
        duration_ms: Number(turn.duration_ms || 0),
        sources: sources.map((s) => ({
          citationIndex: s.citationIndex,
          url: s.url,
          title: s.title,
          domain: s.domain,
          wordCount: s.wordCount,
          excerpt: s.excerpt
        })),
        updated_at: new Date().toISOString()
      };

      try {
        const res = await httpRequest(`${baseUrl}/collections/${collection}/points?wait=true`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            points: [
              {
                id: pointId,
                vector,
                payload
              }
            ]
          }),
          headersTimeout: 3000,
          bodyTimeout: 3000
        });
        if (res.body && typeof res.body.dump === 'function') {
          await res.body.dump().catch(() => {});
        }
        return res.statusCode >= 200 && res.statusCode < 300;
      } catch (_) {
        return false;
      }
    },

    /**
     * Remove todos os pontos associados a uma conversa no Qdrant quando excluída na barra lateral.
     */
    async deleteConversationPoints(conversationId) {
      const baseUrl = await ensureCollection();
      if (!baseUrl) return false;

      try {
        const res = await httpRequest(`${baseUrl}/collections/${collection}/points/delete?wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filter: {
              must: [
                {
                  key: 'conversation_id',
                  match: { value: Number(conversationId) }
                }
              ]
            }
          }),
          headersTimeout: 3000,
          bodyTimeout: 3000
        });
        if (res.body && typeof res.body.dump === 'function') {
          await res.body.dump().catch(() => {});
        }
        return res.statusCode >= 200 && res.statusCode < 300;
      } catch (_) {
        return false;
      }
    }
  };
}

module.exports = {
  COLLECTION_NAME,
  textToDeterministicVector,
  createQdrantStore
};
