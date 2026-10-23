'use strict';

const crypto = require('node:crypto');
const { request } = require('undici');

const DEFAULT_QDRANT_URLS = [
  'http://127.0.0.1:6333',
  'http://192.168.3.109:6333'
];
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_EMBED_MODEL = 'bge-m3:latest';
const COLLECTION_NAME = 'deepevil_conversations';
const VECTOR_DIM = 384;

/**
 * Projeta/comprime qualquer vetor numérico (ex.: bge-m3 1024d) para a dimensão alvo
 * (ex.: 384d) via average-pooling determinístico + normalização L2 (Cosine).
 */
function projectVectorToDim(rawVector, targetDim = VECTOR_DIM) {
  if (!Array.isArray(rawVector) || rawVector.length === 0) {
    return null;
  }
  if (rawVector.length === targetDim) {
    return rawVector.map((v) => Number(Number(v).toFixed(6)));
  }

  const out = new Float32Array(targetDim);
  const counts = new Uint16Array(targetDim);
  for (let i = 0; i < rawVector.length; i++) {
    const bucket = Math.floor((i * targetDim) / rawVector.length);
    out[bucket] += Number(rawVector[i]) || 0;
    counts[bucket] += 1;
  }

  let norm = 0;
  for (let j = 0; j < targetDim; j++) {
    if (counts[j] > 0) out[j] /= counts[j];
    norm += out[j] * out[j];
  }
  norm = Math.sqrt(norm) || 1;
  return Array.from(out, (v) => Number((v / norm).toFixed(6)));
}

/**
 * Gera um vetor determinístico normalizado de 384 dimensões (Cosine) a partir do texto
 * para indexação rápida de fallback quando o motor de embeddings não estiver acessível.
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
 * Gera embedding semântico real via Ollama (/api/embed com bge-m3) e retorna tanto
 * o vetor nativo (1024d) quanto o projetado para `targetDim` (384d), com fallback
 * transparente para `textToDeterministicVector`.
 */
async function embedTextSemantic(text, {
  env = process.env,
  httpRequest = request,
  targetDim = VECTOR_DIM
} = {}) {
  const cleanText = String(text || '').trim().slice(0, 2000) || 'deepevil';
  const ollamaUrl = String(env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, '');
  const embedModel = String(env.OLLAMA_EMBED_MODEL || DEFAULT_EMBED_MODEL).trim();

  try {
    const res = await httpRequest(`${ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: embedModel,
        input: cleanText
      }),
      headersTimeout: 2000,
      bodyTimeout: 2000
    });

    if (res && res.statusCode >= 200 && res.statusCode < 300) {
      const data = await res.body.json();
      const rawVec = Array.isArray(data?.embeddings?.[0])
        ? data.embeddings[0]
        : Array.isArray(data?.embedding)
        ? data.embedding
        : null;
      if (rawVec && rawVec.length > 0) {
        return {
          rawVector: rawVec,
          vector384: projectVectorToDim(rawVec, targetDim),
          model: embedModel,
          semantic: true
        };
      }
    } else if (res?.body && typeof res.body.dump === 'function') {
      await res.body.dump().catch(() => {});
    }
  } catch (_) {
    // Fallback determinístico silencioso
  }

  const fallback = textToDeterministicVector(cleanText, targetDim);
  return {
    rawVector: fallback,
    vector384: fallback,
    model: 'deterministic-sha256',
    semantic: false
  };
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
      const emb = await embedTextSemantic(query, { env, httpRequest, targetDim: VECTOR_DIM });
      const vector = emb.vector384;
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
     * Busca semântica híbrida (Qdrant Local + Base de Conhecimento Homelab)
     * convertendo hits relevantes em fontes verificadas para o modo `hybrid`.
     */
    async searchHybridSources(query, limit = 2) {
      const baseUrl = await ensureCollection();
      if (!baseUrl || !query) return [];

      const emb = await embedTextSemantic(query, { env, httpRequest, targetDim: VECTOR_DIM });
      const hybridSources = [];

      // 1. Consulta conversas anteriores em deepevil_conversations (384d)
      try {
        const res = await httpRequest(`${baseUrl}/collections/${collection}/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector: emb.vector384,
            limit: Math.max(1, limit),
            with_payload: true
          }),
          headersTimeout: 2500,
          bodyTimeout: 2500
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = await res.body.json();
          const hits = Array.isArray(data?.result) ? data.result : [];
          for (const h of hits) {
            const p = h?.payload || {};
            const excerpt = String(p.answer_markdown || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
            if (!excerpt || excerpt.length < 60) continue;
            const firstSrcUrl = p.sources?.[0]?.url || `http://127.0.0.1:3000/c/${p.conversation_id || 1}`;
            hybridSources.push({
              url: firstSrcUrl,
              title: `[Memória Local] ${p.question || p.conversation_title || 'Síntese Anterior'}`,
              domain: 'local.deepevil.memory',
              siteName: 'DeepEvil Local Memory',
              excerpt,
              wordCount: excerpt.split(/\s+/).filter(Boolean).length,
              charCount: excerpt.length
            });
            if (hybridSources.length >= limit) break;
          }
        } else if (res.body && typeof res.body.dump === 'function') {
          await res.body.dump().catch(() => {});
        }
      } catch (_) {
        // Ignora falha silenciosamente
      }

      // 2. Se bge-m3 1024d estiver ativo e ainda houver espaço, consulta pe-agents-ibm-context
      if (emb.semantic && emb.rawVector.length === 1024 && hybridSources.length < limit) {
        try {
          const resCtx = await httpRequest(`${baseUrl}/collections/pe-agents-ibm-context/points/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vector: emb.rawVector,
              limit: limit - hybridSources.length,
              with_payload: true
            }),
            headersTimeout: 2500,
            bodyTimeout: 2500
          });
          if (resCtx.statusCode >= 200 && resCtx.statusCode < 300) {
            const dataCtx = await resCtx.body.json();
            const hitsCtx = Array.isArray(dataCtx?.result) ? dataCtx.result : [];
            for (const h of hitsCtx) {
              const p = h?.payload || {};
              const rawContent = String(p.content || p.text || p.decisions || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
              if (!rawContent || rawContent.length < 50) continue;
              hybridSources.push({
                url: `http://127.0.0.1:6333/dashboard#/collections/pe-agents-ibm-context`,
                title: `[Base Homelab] ${p.section || p.action || 'Conhecimento Técnico Indexado'}`,
                domain: 'homelab.local.kb',
                siteName: 'Homelab Knowledge Base',
                excerpt: rawContent,
                wordCount: rawContent.split(/\s+/).filter(Boolean).length,
                charCount: rawContent.length
              });
            }
          } else if (resCtx.body && typeof resCtx.body.dump === 'function') {
            await resCtx.body.dump().catch(() => {});
          }
        } catch (_) {
          // Ignora falha silenciosamente
        }
      }

      return hybridSources.slice(0, limit);
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

      const emb = await embedTextSemantic(textForEmbedding, { env, httpRequest, targetDim: VECTOR_DIM });
      const vector = emb.vector384;
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
  projectVectorToDim,
  textToDeterministicVector,
  embedTextSemantic,
  createQdrantStore
};
