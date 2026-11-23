'use strict';

const crypto = require('node:crypto');
const { request } = require('undici');

const DEFAULT_QDRANT_URLS = [
  'http://127.0.0.1:6333',
  'http://localhost:6333'
];
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_EMBED_MODEL = 'bge-m3:latest';
const DEFAULT_COLLECTION = 'deepevil_conversations_v2';
const COLLECTION_NAME = DEFAULT_COLLECTION;
const DEFAULT_VECTOR_SIZE = 1024;
const VECTOR_DIM = DEFAULT_VECTOR_SIZE;

const DEFAULT_EMBED_TIMEOUT_MS = 4500;
const DEFAULT_BATCH_EMBED_TIMEOUT_MS = 2500;
const DEFAULT_SCORE_THRESHOLD = 0.68;
const DEFAULT_SEMANTIC_CACHE_THRESHOLD = 0.92;
const DEFAULT_SEMANTIC_CACHE_MAX_AGE_HOURS = 24;
const MAX_EMBED_TEXT_CHARS = 4000;

/**
 * Normaliza um vetor numérico em norma L2 (Cosine) preservando sua dimensão nativa.
 */
function normalizeL2(rawVector) {
  if (!Array.isArray(rawVector) || rawVector.length === 0) {
    return null;
  }
  let sumSq = 0;
  for (let i = 0; i < rawVector.length; i++) {
    const v = Number(rawVector[i]);
    if (!Number.isFinite(v)) return null;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) {
    return null;
  }
  const out = new Array(rawVector.length);
  for (let i = 0; i < rawVector.length; i++) {
    out[i] = Number(rawVector[i]) / norm;
  }
  return out;
}

/**
 * Calcula similaridade de cosseno entre dois vetores de mesma dimensão.
 * Retorna 0 para entradas inválidas, dimensões incompatíveis ou vetores nulos.
 */
function cosineSimilarity(vecA, vecB) {
  if (
    (!Array.isArray(vecA) && !ArrayBuffer.isView(vecA)) ||
    (!Array.isArray(vecB) && !ArrayBuffer.isView(vecB))
  ) {
    return 0;
  }
  const len = vecA.length;
  if (len === 0 || len !== vecB.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const a = Number(vecA[i]);
    const b = Number(vecB[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

/**
 * Projeta/comprime um vetor numérico para `targetDim` via average-pooling determinístico + L2.
 * Mantida apenas para retrocompatibilidade com coleções legadas 384d e testes legados;
 * NÃO é usada no fluxo nativo 1024d (`bge-m3`).
 */
function projectVectorToDim(rawVector, targetDim = 384) {
  if (!Array.isArray(rawVector) || rawVector.length === 0) {
    return null;
  }
  if (rawVector.length === targetDim) {
    return normalizeL2(rawVector);
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
 * @deprecated Mantida apenas por retrocompatibilidade de exportação.
 * NUNCA utilizada em indexação ou busca Qdrant para não poluir coleções semânticas.
 */
function textToDeterministicVector(text, dim = DEFAULT_VECTOR_SIZE) {
  const clean = String(text || '').toLowerCase().trim() || 'deepevil';
  const vec = new Float32Array(dim);
  const tokens = clean.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const hash = crypto.createHash('sha256').update(tokens[i]).digest();
    for (let j = 0; j < dim; j++) {
      const byteVal = hash[j % hash.length];
      vec[j] += (byteVal / 127.5) - 1.0;
    }
  }

  let norm = 0;
  for (let j = 0; j < dim; j++) {
    norm += vec[j] * vec[j];
  }
  norm = Math.sqrt(norm) || 1;

  return Array.from(vec, (v) => Number((v / norm).toFixed(6)));
}

function normalizeEmbedModelTag(modelName) {
  return String(modelName || DEFAULT_EMBED_MODEL)
    .trim()
    .replace(/:latest$/i, '');
}

/**
 * Gera embedding semântico real via Ollama (`POST /api/embed` com `bge-m3` 1024d nativo).
 * - Quando `targetDim` é `1024` (padrão) e o modelo retorna 1024d, preserva o vetor L2-normalizado
 *   de 1024d intocado (sem `projectVectorToDim`).
 * - Quando `targetDim` é explicitamente diferente (ex.: `384` em coleções legadas), projeta sob demanda.
 * - NUNCA faz fallback para hash SHA-256: retorna `null` em caso de falha ou timeout.
 */
async function embedTextSemantic(text, {
  env = process.env,
  httpRequest = request,
  requestFn = null,
  targetDim = DEFAULT_VECTOR_SIZE,
  timeoutMs = DEFAULT_EMBED_TIMEOUT_MS,
  signal = null
} = {}) {
  const cleanText = String(text || '').trim().slice(0, MAX_EMBED_TEXT_CHARS);
  if (!cleanText) return null;

  const reqFn = requestFn || httpRequest;
  const ollamaUrl = String(env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, '');
  const embedModel = String(env.OLLAMA_EMBED_MODEL || DEFAULT_EMBED_MODEL).trim();
  const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_EMBED_TIMEOUT_MS;

  try {
    const reqOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: embedModel,
        input: cleanText
      }),
      headersTimeout: effectiveTimeout,
      bodyTimeout: effectiveTimeout
    };
    if (signal) reqOpts.signal = signal;

    const res = await reqFn(`${ollamaUrl}/api/embed`, reqOpts);

    if (res && res.statusCode >= 200 && res.statusCode < 300) {
      const data = await res.body.json();
      const rawVec = Array.isArray(data?.embeddings?.[0])
        ? data.embeddings[0]
        : Array.isArray(data?.embedding)
        ? data.embedding
        : null;

      const normalizedNative = normalizeL2(rawVec);
      if (normalizedNative && normalizedNative.length > 0) {
        const primaryVector =
          targetDim === normalizedNative.length
            ? normalizedNative
            : projectVectorToDim(normalizedNative, targetDim);

        const result = {
          vector: primaryVector,
          rawVector: normalizedNative,
          dim: primaryVector.length,
          model: embedModel,
          semantic: true
        };

        // Propriedade lazy apenas para retrocompatibilidade com consumidores/testes 384d
        // sem executar projectVectorToDim no caminho nativo 1024d.
        let cached384 = targetDim === 384 ? primaryVector : null;
        Object.defineProperty(result, 'vector384', {
          enumerable: true,
          configurable: true,
          get() {
            if (!cached384) {
              cached384 = projectVectorToDim(normalizedNative, 384);
            }
            return cached384;
          }
        });

        return result;
      }
      console.warn(`[DeepEvil][Qdrant] Resposta vazia ou inválida de ${ollamaUrl}/api/embed (${embedModel}).`);
      return null;
    }

    if (res?.body && typeof res.body.dump === 'function') {
      await res.body.dump().catch(() => {});
    }
    console.warn(
      `[DeepEvil][Qdrant] Ollama /api/embed retornou HTTP ${res?.statusCode ?? 'desconhecido'} — pulando operação semântica (sem fallback SHA-256).`
    );
    return null;
  } catch (err) {
    console.warn(
      `[DeepEvil][Qdrant] Falha/timeout ao gerar embedding semântico (${embedModel}): ${err?.message || err} — pulando operação semântica (sem fallback SHA-256).`
    );
    return null;
  }
}

/**
 * Gera embeddings semânticos 1024d L2-normalizados em lote usando o suporte nativo a array
 * de `POST /api/embed` do Ollama em 1 único round-trip HTTP.
 * Nunca lança exceção: retorna array de `null` de mesmo tamanho em caso de offline/timeout.
 *
 * @param {string[]} texts
 * @param {object} [options]
 * @returns {Promise<Array<number[] | null>>}
 */
async function embedTextsBatch(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const env = options.env || process.env;
  const reqFn = options.requestFn || options.httpRequest || request;
  const ollamaUrl = String(env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, '');
  const embedModel = String(options.model || env.OLLAMA_EMBED_MODEL || DEFAULT_EMBED_MODEL).trim();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_BATCH_EMBED_TIMEOUT_MS;
  const maxChars = Number.isFinite(Number(options.maxChars)) && Number(options.maxChars) > 0
    ? Number(options.maxChars)
    : 2000;
  const signal = options.signal || null;

  const output = new Array(texts.length).fill(null);
  const activeIndices = [];
  const cleanInputs = [];

  for (let i = 0; i < texts.length; i++) {
    const cleaned = String(texts[i] ?? '').trim().slice(0, maxChars);
    if (cleaned) {
      activeIndices.push(i);
      cleanInputs.push(cleaned);
    }
  }

  if (cleanInputs.length === 0) {
    return output;
  }

  try {
    const reqOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: embedModel,
        input: cleanInputs
      }),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    };
    if (signal) reqOpts.signal = signal;

    const res = await reqFn(`${ollamaUrl}/api/embed`, reqOpts);

    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      if (res?.body && typeof res.body.dump === 'function') {
        await res.body.dump().catch(() => {});
      }
      return output;
    }

    const data = await res.body.json();
    const embeddings = Array.isArray(data?.embeddings) ? data.embeddings : [];

    for (let k = 0; k < activeIndices.length; k++) {
      const raw = embeddings[k];
      if (Array.isArray(raw) && raw.length > 0) {
        output[activeIndices[k]] = normalizeL2(raw);
      }
    }

    return output;
  } catch (_) {
    return output;
  }
}

function inspectCollectionVectorConfig(collectionJson) {
  const vectorsCfg = collectionJson?.result?.config?.params?.vectors;
  if (!vectorsCfg || typeof vectorsCfg !== 'object') {
    return { size: DEFAULT_VECTOR_SIZE, namedVector: null };
  }
  if (typeof vectorsCfg.size === 'number' && vectorsCfg.size > 0) {
    return { size: vectorsCfg.size, namedVector: null };
  }
  if (vectorsCfg.semantic && typeof vectorsCfg.semantic.size === 'number') {
    return { size: vectorsCfg.semantic.size, namedVector: 'semantic' };
  }
  for (const [name, cfg] of Object.entries(vectorsCfg)) {
    if (cfg && typeof cfg.size === 'number' && cfg.size > 0) {
      return { size: cfg.size, namedVector: name };
    }
  }
  return { size: DEFAULT_VECTOR_SIZE, namedVector: null };
}

function summarizeAnswerForIndexing(answerMarkdown = '', maxLen = 1400) {
  const clean = String(answerMarkdown || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~|>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.75 ? cut.slice(0, lastSpace) : cut).trim();
}

function isExternalWebUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'local.deepevil.memory' ||
      host === 'homelab.local.kb' ||
      host === 'localhost' ||
      host === '127.0.0.1'
    ) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Camada de persistência vetorial e documental nativa 1024d (`bge-m3`) no Qdrant Vector DB (6333).
 * Sincroniza conversas, turnos verificados, fontes Readability e cache semântico na coleção
 * `deepevil_conversations_v2` (ou na coleção configurada em `QDRANT_COLLECTION`, detectando
 * automaticamente a dimensão real via `GET /collections/:name`).
 */
function createQdrantStore(options = {}) {
  const env = options.env || process.env;
  const httpRequest = options.requestFn || request;
  const collection = options.collection || env.QDRANT_COLLECTION || DEFAULT_COLLECTION;
  const configuredUrl = String(env.QDRANT_URL || '').trim().replace(/\/+$/, '');
  const candidateUrls = configuredUrl
    ? [configuredUrl, ...DEFAULT_QDRANT_URLS.filter((u) => u !== configuredUrl)]
    : DEFAULT_QDRANT_URLS;

  let activeBaseUrl = candidateUrls[0];
  let collectionInitialized = false;
  let collectionVectorSize = Number(options.vectorSize) || DEFAULT_VECTOR_SIZE;
  let collectionNamedVector = null;
  let kbCollectionMeta = null;

  function formatSearchVector(vec, namedVector = collectionNamedVector) {
    if (namedVector) {
      return { name: namedVector, vector: vec };
    }
    return vec;
  }

  function formatUpsertVector(vec, namedVector = collectionNamedVector) {
    if (namedVector) {
      return { [namedVector]: vec };
    }
    return vec;
  }

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
        if (res.body && typeof res.body.dump === 'function') {
          await res.body.dump().catch(() => {});
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

      if (checkRes.statusCode >= 200 && checkRes.statusCode < 300) {
        const colInfo = checkRes.body && typeof checkRes.body.json === 'function'
          ? await checkRes.body.json().catch(() => null)
          : null;
        if (colInfo) {
          const inspected = inspectCollectionVectorConfig(colInfo);
          collectionVectorSize = inspected.size;
          collectionNamedVector = inspected.namedVector;
          if (collectionVectorSize !== DEFAULT_VECTOR_SIZE) {
            console.warn(
              `[DeepEvil][Qdrant] Coleção '${collection}' existente usa ${collectionVectorSize}d (padrão v2 nativo: ${DEFAULT_VECTOR_SIZE}d). Adaptando consultas para ${collectionVectorSize}d.`
            );
          }
        }
        collectionInitialized = true;
        return baseUrl;
      }

      if (checkRes.body && typeof checkRes.body.dump === 'function') {
        await checkRes.body.dump().catch(() => {});
      }

      if (checkRes.statusCode === 404) {
        const targetSize = Number(options.vectorSize) || DEFAULT_VECTOR_SIZE;
        const createRes = await httpRequest(`${baseUrl}/collections/${collection}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vectors: {
              size: targetSize,
              distance: 'Cosine'
            }
          }),
          headersTimeout: 3000,
          bodyTimeout: 3000
        });
        if (createRes.body && typeof createRes.body.dump === 'function') {
          await createRes.body.dump().catch(() => {});
        }
        if (createRes.statusCode >= 200 && createRes.statusCode < 300) {
          collectionVectorSize = targetSize;
          collectionNamedVector = null;
          collectionInitialized = true;
          return baseUrl;
        }
        return null;
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  async function inspectKbCollection(baseUrl, kbName) {
    if (kbCollectionMeta && kbCollectionMeta.name === kbName) {
      return kbCollectionMeta;
    }
    try {
      const res = await httpRequest(`${baseUrl}/collections/${kbName}`, {
        method: 'GET',
        headersTimeout: 1500,
        bodyTimeout: 1500
      });
      if (res.statusCode >= 200 && res.statusCode < 300 && res.body && typeof res.body.json === 'function') {
        const json = await res.body.json().catch(() => null);
        const inspected = inspectCollectionVectorConfig(json);
        kbCollectionMeta = { name: kbName, ...inspected, exists: true };
        return kbCollectionMeta;
      }
      if (res.body && typeof res.body.dump === 'function') {
        await res.body.dump().catch(() => {});
      }
    } catch (_) {
      // Ignora erro de inspeção
    }
    kbCollectionMeta = { name: kbName, size: DEFAULT_VECTOR_SIZE, namedVector: null, exists: false };
    return kbCollectionMeta;
  }

  return {
    collection,

    getVectorSize() {
      return collectionVectorSize;
    },

    async getStatus() {
      const url = await resolveHealthyUrl();
      return {
        online: Boolean(url),
        connected: Boolean(url),
        url: url || candidateUrls[0],
        collection,
        vectorSize: collectionVectorSize
      };
    },

    async checkHealth() {
      const url = await ensureCollection();
      return {
        online: Boolean(url),
        connected: Boolean(url),
        url: url || candidateUrls[0],
        collection,
        vectorSize: collectionVectorSize
      };
    },

    async searchKnowledge(query, limit = 8, searchOptions = {}) {
      const baseUrl = await ensureCollection();
      if (!baseUrl || !query) return [];

      const emb = await embedTextSemantic(query, {
        env,
        httpRequest,
        targetDim: collectionVectorSize,
        signal: searchOptions.signal || null
      });
      if (!emb || !emb.semantic || !Array.isArray(emb.vector)) {
        return [];
      }

      const bodyObj = {
        vector: formatSearchVector(emb.vector),
        limit,
        with_payload: true
      };
      if (Number.isFinite(Number(searchOptions.scoreThreshold))) {
        bodyObj.score_threshold = Number(searchOptions.scoreThreshold);
      }

      try {
        const res = await httpRequest(`${baseUrl}/collections/${collection}/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyObj),
          headersTimeout: 3000,
          bodyTimeout: 3000,
          ...(searchOptions.signal ? { signal: searchOptions.signal } : {})
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
     * Busca semântica híbrida (Qdrant Local 1024d + Base de Conhecimento Homelab)
     * com `score_threshold: 0.68` e proteção Anti-Model-Collapse:
     * - Prioriza retornar os trechos reais das fontes web verificadas armazenadas no hit;
     * - Caso precise retornar uma nota de memória local, marca explicitamente
     *   `domain: 'local.deepevil.memory'`, `isLocalMemory: true` e
     *   `url: 'https://local.deepevil.memory/turn/' + turnId` (nunca sob URL externa).
     */
    async searchHybridSources(query, limit = 2, searchOptions = {}) {
      const baseUrl = await ensureCollection();
      if (!baseUrl || !query) return [];

      const emb = await embedTextSemantic(query, {
        env,
        httpRequest,
        targetDim: collectionVectorSize,
        signal: searchOptions.signal || null
      });
      if (!emb || !emb.semantic || !Array.isArray(emb.vector)) {
        return [];
      }

      const scoreThreshold = Number.isFinite(Number(searchOptions.scoreThreshold))
        ? Number(searchOptions.scoreThreshold)
        : DEFAULT_SCORE_THRESHOLD;
      const hybridSources = [];
      const seenUrls = new Set();

      // 1. Consulta conversas anteriores em deepevil_conversations_v2 (1024d nativo)
      try {
        const res = await httpRequest(`${baseUrl}/collections/${collection}/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector: formatSearchVector(emb.vector),
            limit: Math.max(2, limit * 2),
            score_threshold: scoreThreshold,
            with_payload: true
          }),
          headersTimeout: 2500,
          bodyTimeout: 2500,
          ...(searchOptions.signal ? { signal: searchOptions.signal } : {})
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = await res.body.json();
          const hits = Array.isArray(data?.result) ? data.result : [];
          for (const h of hits) {
            if (hybridSources.length >= limit) break;
            if (Number.isFinite(h?.score) && h.score < scoreThreshold) continue;
            const p = h?.payload || {};

            // Anti-Model-Collapse: retorna primeiro os trechos reais de fontes web verificadas
            const verifiedSavedSources = Array.isArray(p.sources)
              ? p.sources.filter(
                  (s) =>
                    s &&
                    isExternalWebUrl(s.url) &&
                    String(s.excerpt || '').trim().length >= 60
                )
              : [];

            if (verifiedSavedSources.length > 0) {
              for (const src of verifiedSavedSources) {
                if (hybridSources.length >= limit) break;
                if (seenUrls.has(src.url)) continue;
                seenUrls.add(src.url);
                const cleanExcerpt = String(src.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
                let srcDomain = String(src.domain || '').trim();
                if (!srcDomain) {
                  try {
                    srcDomain = new URL(src.url).hostname;
                  } catch (_) {
                    srcDomain = 'web';
                  }
                }
                hybridSources.push({
                  url: src.url,
                  title: String(src.title || srcDomain),
                  domain: srcDomain,
                  siteName: src.siteName || srcDomain,
                  excerpt: cleanExcerpt,
                  wordCount: cleanExcerpt.split(/\s+/).filter(Boolean).length,
                  charCount: cleanExcerpt.length,
                  fromQdrantArchive: true,
                  qdrantScore: h.score
                });
              }
              continue;
            }

            // Fallback explícito como memória local (NUNCA mascarando saída de LLM sob URL externa)
            const turnId = p.turn_id ?? h?.id ?? 'unknown';
            const localUrl = `https://local.deepevil.memory/turn/${turnId}`;
            if (seenUrls.has(localUrl)) continue;
            const excerpt = summarizeAnswerForIndexing(p.answer_markdown || '', 1400);
            if (!excerpt || excerpt.length < 60) continue;
            seenUrls.add(localUrl);
            hybridSources.push({
              url: localUrl,
              title: `[Memória Local] ${p.question || p.conversation_title || 'Síntese Anterior'}`,
              domain: 'local.deepevil.memory',
              siteName: 'DeepEvil Local Memory',
              isLocalMemory: true,
              excerpt,
              wordCount: excerpt.split(/\s+/).filter(Boolean).length,
              charCount: excerpt.length,
              qdrantScore: h.score
            });
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
          const kbMeta = await inspectKbCollection(baseUrl, 'pe-agents-ibm-context');
          if (kbMeta.exists && kbMeta.size === 1024) {
            const resCtx = await httpRequest(`${baseUrl}/collections/pe-agents-ibm-context/points/search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                vector: formatSearchVector(emb.rawVector, kbMeta.namedVector),
                limit: limit - hybridSources.length,
                score_threshold: scoreThreshold,
                with_payload: true
              }),
              headersTimeout: 2500,
              bodyTimeout: 2500,
              ...(searchOptions.signal ? { signal: searchOptions.signal } : {})
            });
            if (resCtx.statusCode >= 200 && resCtx.statusCode < 300) {
              const dataCtx = await resCtx.body.json();
              const hitsCtx = Array.isArray(dataCtx?.result) ? dataCtx.result : [];
              for (const h of hitsCtx) {
                if (hybridSources.length >= limit) break;
                if (Number.isFinite(h?.score) && h.score < scoreThreshold) continue;
                const p = h?.payload || {};
                const rawContent = String(p.content || p.text || p.decisions || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
                if (!rawContent || rawContent.length < 50) continue;
                const kbUrl = `https://local.deepevil.memory/kb/pe-agents-ibm-context/${h?.id ?? hybridSources.length + 1}`;
                if (seenUrls.has(kbUrl)) continue;
                seenUrls.add(kbUrl);
                hybridSources.push({
                  url: kbUrl,
                  title: `[Base Homelab] ${p.section || p.action || 'Conhecimento Técnico Indexado'}`,
                  domain: 'homelab.local.kb',
                  siteName: 'Homelab Knowledge Base',
                  isLocalMemory: true,
                  excerpt: rawContent,
                  wordCount: rawContent.split(/\s+/).filter(Boolean).length,
                  charCount: rawContent.length,
                  qdrantScore: h.score
                });
              }
            } else if (resCtx.body && typeof resCtx.body.dump === 'function') {
              await resCtx.body.dump().catch(() => {});
            }
          }
        } catch (_) {
          // Ignora falha silenciosamente
        }
      }

      return hybridSources.slice(0, limit);
    },

    /**
     * Consulta o cache semântico de perguntas repetidas (`score >= 0.92`, `ageHours <= 24`).
     * Ignora automaticamente consultas sensíveis a frescor (`freshness === 'day' | 'week'`).
     */
    async findSemanticCacheHit(question, cacheOptions = {}) {
      const freshness = String(cacheOptions.freshness || '').trim().toLowerCase();
      if (freshness === 'day' || freshness === 'week' || cacheOptions.bypassCache === true) {
        return null;
      }

      const cleanQuestion = String(question || '').trim();
      if (!cleanQuestion) return null;

      const baseUrl = await ensureCollection();
      if (!baseUrl) return null;

      const threshold = Number.isFinite(Number(cacheOptions.threshold))
        ? Number(cacheOptions.threshold)
        : DEFAULT_SEMANTIC_CACHE_THRESHOLD;
      const maxAgeHours = Number.isFinite(Number(cacheOptions.maxAgeHours))
        ? Number(cacheOptions.maxAgeHours)
        : DEFAULT_SEMANTIC_CACHE_MAX_AGE_HOURS;

      const emb = await embedTextSemantic(cleanQuestion, {
        env,
        httpRequest,
        targetDim: collectionVectorSize,
        signal: cacheOptions.signal || null
      });
      if (!emb || !emb.semantic || !Array.isArray(emb.vector)) {
        return null;
      }

      try {
        const res = await httpRequest(`${baseUrl}/collections/${collection}/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector: formatSearchVector(emb.vector),
            limit: 5,
            score_threshold: threshold,
            with_payload: true
          }),
          headersTimeout: 2500,
          bodyTimeout: 2500,
          ...(cacheOptions.signal ? { signal: cacheOptions.signal } : {})
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (res.body && typeof res.body.dump === 'function') {
            await res.body.dump().catch(() => {});
          }
          return null;
        }

        const data = await res.body.json();
        const hits = Array.isArray(data?.result) ? data.result : [];
        const nowMs = Date.now();

        for (const h of hits) {
          if (!Number.isFinite(h?.score) || h.score < threshold) continue;
          const p = h?.payload || {};
          if (p.status !== 'completed') continue;
          if (!p.answer_markdown || !Array.isArray(p.sources) || p.sources.length === 0) continue;
          if (p.low_faithfulness === true) continue;
          if (Number.isFinite(Number(p.faithfulness_score)) && Number(p.faithfulness_score) < 0.5) continue;

          if (cacheOptions.searchLang && p.search_lang && p.search_lang !== cacheOptions.searchLang) continue;
          if (cacheOptions.focusMode && p.focus_mode && p.focus_mode !== cacheOptions.focusMode) continue;

          const updatedMs = Date.parse(p.updated_at || p.created_at || '');
          if (!Number.isFinite(updatedMs)) continue;
          const ageHours = (nowMs - updatedMs) / (1000 * 60 * 60);
          if (ageHours < 0 || ageHours > maxAgeHours) continue;

          return {
            hit: true,
            score: h.score,
            ageHours: Number(ageHours.toFixed(2)),
            turnId: p.turn_id ?? h.id,
            conversationId: p.conversation_id ?? null,
            question: String(p.question || ''),
            answerMarkdown: String(p.answer_markdown),
            sources: p.sources,
            model: String(p.model || ''),
            provider: String(p.provider || ''),
            updatedAt: p.updated_at || null
          };
        }

        return null;
      } catch (_) {
        return null;
      }
    },

    /**
     * Indexa um turno completo verificado no Qdrant Vector DB (1024d nativo `bge-m3`).
     * Regras de qualidade:
     * - Apenas turnos `completed` com `sources.length > 0` e sem aviso de baixa fidelidade;
     * - Indexa pergunta + resumo + títulos/domínios das fontes verificadas (até 4000 chars);
     * - NUNCA grava vetores SHA-256: pula com aviso caso o Ollama `/api/embed` falhe.
     */
    async indexTurn({
      conversation,
      turn,
      sources = [],
      citationVerification = null,
      lowFidelity = false,
      groundingScore = null
    }) {
      if (!turn?.id) return null;
      const status = String(turn.status || 'completed');
      if (status !== 'completed') {
        return null;
      }
      if (!Array.isArray(sources) || sources.length === 0) {
        return null;
      }

      const parseScore = (val) =>
        val !== null && val !== undefined && val !== '' && Number.isFinite(Number(val)) ? Number(val) : null;
      const faithfulnessScore =
        parseScore(citationVerification?.faithfulnessScore) ??
        parseScore(groundingScore) ??
        parseScore(turn.faithfulness_score);
      const hasLowFaithfulness =
        Boolean(lowFidelity) ||
        Boolean(turn.low_faithfulness) ||
        (citationVerification &&
          citationVerification.totalCitations > 0 &&
          citationVerification.faithfulnessScore < 0.5) ||
        (faithfulnessScore !== null && faithfulnessScore < 0.5);

      if (hasLowFaithfulness) {
        console.warn(
          `[DeepEvil][Qdrant] Pulando indexTurn #${turn.id}: resposta sinalizada com baixa fidelidade (faithfulnessScore=${faithfulnessScore}).`
        );
        return null;
      }

      const baseUrl = await ensureCollection();
      if (!baseUrl) return null;

      const questionStr = String(turn.question || '').trim();
      const convTitle = String(conversation?.title || '').trim();
      const summaryStr = summarizeAnswerForIndexing(turn.answer_markdown || '', 1500);
      const sourcesCatalog = sources
        .map((s) => `${String(s.title || '').trim()} (${String(s.domain || '').trim()})`)
        .filter(Boolean)
        .join('; ');

      const textParts = [
        questionStr,
        convTitle && convTitle !== questionStr ? convTitle : '',
        summaryStr,
        sourcesCatalog ? `Fontes: ${sourcesCatalog}` : ''
      ].filter(Boolean);

      const textForEmbedding = textParts.join('\n').slice(0, MAX_EMBED_TEXT_CHARS);

      const emb = await embedTextSemantic(textForEmbedding, {
        env,
        httpRequest,
        targetDim: collectionVectorSize
      });
      if (!emb || !emb.semantic || !Array.isArray(emb.vector)) {
        console.warn(
          `[DeepEvil][Qdrant] Pulando indexTurn #${turn.id}: embedding semântico indisponível (sem fallback SHA-256).`
        );
        return null;
      }

      const pointId = Number(turn.id);
      const normalizedModel = normalizeEmbedModelTag(emb.model);

      const payload = {
        conversation_id: Number(conversation?.id || turn.conversation_id),
        conversation_title: String(conversation?.title || turn.question || ''),
        turn_id: pointId,
        question: questionStr,
        search_query: String(turn.search_query || ''),
        answer_markdown: String(turn.answer_markdown || ''),
        answer_summary: summaryStr,
        status,
        provider: String(turn.provider || ''),
        model: String(turn.model || ''),
        embed_model: normalizedModel,
        vector_dim: emb.vector.length,
        focus_mode: String(turn.focus_mode || ''),
        search_scope: String(turn.search_scope || ''),
        search_lang: String(turn.search_lang || ''),
        ...(faithfulnessScore !== null ? { faithfulness_score: faithfulnessScore } : {}),
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
                vector: formatUpsertVector(emb.vector),
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
  DEFAULT_COLLECTION,
  COLLECTION_NAME,
  DEFAULT_VECTOR_SIZE,
  VECTOR_DIM,
  DEFAULT_SCORE_THRESHOLD,
  DEFAULT_SEMANTIC_CACHE_THRESHOLD,
  normalizeL2,
  cosineSimilarity,
  projectVectorToDim,
  textToDeterministicVector,
  embedTextSemantic,
  embedTextsBatch,
  createQdrantStore
};
