'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { request: undiciRequest } = require('undici');
const { createDatabase } = require('./db');
const { createQdrantStore } = require('./qdrant');
const {
  FOCUS_MODES,
  applyFocusModeToQuery,
  buildContextualSearchQuery,
  searchBrave,
  normalizeSearchScope,
  normalizeSearchLang,
  localizeSourceHeadlines,
  planSearchIntent
} = require('./search');
const { extractTopSources } = require('./extractor');
const {
  SUPPORTED_TRANSLATION_LANGUAGES,
  resolveLlmConfig,
  listOllamaModels,
  streamAnswer,
  translateTurnMarkdown,
  verifyCitationGrounding,
  cleanupWslKeepAlive
} = require('./llm');
const {
  renderAnswerMarkdownWithFootnotes,
  renderTurnSourcesFootnotes,
  renderPipelineStatusBadge,
  renderTurnCard,
  renderSidebarConversations,
  renderComposerContextSlot,
  renderComposerForm,
  renderMainStage,
  renderFullPage
} = require('./render');
const {
  isLoopbackAddress,
  isAllowedHostHeader,
  isAllowedOrigin,
  escapeHtml,
  sanitizeSseDataLines,
  validateTargetLang,
  parsePositiveInt,
  asyncHandler
} = require('./security');

const MAX_QUESTION_LENGTH = 2000;

const SEARCH_API_FOCUS_MAP = Object.freeze({
  general: 'web',
  sec_ops: 'secops',
  osint: 'web',
  market: 'web',
  web: 'web',
  secops: 'secops',
  code: 'code',
  academic: 'academic',
  hybrid: 'hybrid'
});

function normalizeFocusMode(rawFocus, allowApiAliases = false) {
  const clean = String(rawFocus || 'web').trim().toLowerCase();
  if (allowApiAliases && Object.prototype.hasOwnProperty.call(SEARCH_API_FOCUS_MAP, clean)) {
    return SEARCH_API_FOCUS_MAP[clean];
  }
  if (Object.prototype.hasOwnProperty.call(FOCUS_MODES, clean)) {
    return clean;
  }
  return 'web';
}

function sanitizeModelName(rawModel) {
  return String(rawModel || '')
    .replace(/[\r\n\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 128);
}

function resolveThrottleMs(env) {
  const raw = env?.SSE_THROTTLE_MS;
  if (raw === 0 || raw === '0') return 0;
  return parsePositiveInt(raw, 40, 1, 1000);
}

function writeSseEvent(targetRes, eventName, payload) {
  if (!targetRes || targetRes.writableEnded) return;
  const safeEvent = String(eventName || 'message').replace(/[\r\n]+/g, '');
  targetRes.write(`event: ${safeEvent}\n${sanitizeSseDataLines(payload)}\n\n`);
}

function setHxTriggerHeader(res, payload) {
  const safeAsciiJson = JSON.stringify(payload).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  res.setHeader('HX-Trigger', safeAsciiJson);
}

/**
 * Remove a barra de ações da resposta durante estados não-concluídos (streaming/error)
 * para garantir que actionToolbarHtml só seja exibida quando status === 'completed'.
 */
function stripActionToolbar(html) {
  return String(html || '').replace(
    /<div class="turn-action-bar"[\s\S]*?(?=<section class="turn-followups"|<footer class="turn-footnotes")/i,
    ''
  );
}

function getEnvStatus(env = process.env, selectedModel = '') {
  const braveKey = String(env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || '').trim();
  const hasBraveKey = Boolean(braveKey && braveKey !== 'sua_chave_brave_search_aqui');
  const llm = resolveLlmConfig(env, selectedModel);
  const hasLlmKey = Boolean(llm.apiKey);

  return {
    hasBraveKey,
    hasLlmKey,
    provider: llm.provider,
    model: llm.model
  };
}

/**
 * Agrupador de quadros SSE (Frame Batching ~42ms / ~24fps):
 * Emite o 1º token imediatamente (0ms de atraso de TTFT) e agrupa deltas intermediários
 * em janelas de `intervalMs`, reduzindo re-renderizações DOM/Markdown em ~75%.
 */
function createFrameBatcher(emitFn, intervalMs = 42) {
  let lastRun = 0;
  let timer = null;
  let pendingArg = null;
  let hasPending = false;

  const invoke = (arg) => {
    lastRun = Date.now();
    hasPending = false;
    pendingArg = null;
    emitFn(arg);
  };

  return {
    push(arg) {
      if (intervalMs <= 0) {
        invoke(arg);
        return;
      }
      const now = Date.now();
      const elapsed = now - lastRun;
      if (elapsed >= intervalMs && !timer) {
        invoke(arg);
        return;
      }
      pendingArg = arg;
      hasPending = true;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (hasPending) {
            invoke(pendingArg);
          }
        }, Math.max(8, intervalMs - elapsed));
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (hasPending) {
        invoke(pendingArg);
      }
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      hasPending = false;
      pendingArg = null;
    }
  };
}

async function probeOllamaHealth(env = process.env) {
  const llmCfg = resolveLlmConfig(env);
  const baseUrl = String(llmCfg.baseUrl || env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
    .trim()
    .replace(/\/+$/, '');
  const t0 = Date.now();

  try {
    const resp = await undiciRequest(`${baseUrl}/api/version`, {
      method: 'GET',
      headersTimeout: 1000,
      bodyTimeout: 1000
    });
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const payload = await resp.body.json().catch(() => null);
      return {
        online: true,
        baseUrl,
        version: payload?.version || null,
        latencyMs: Date.now() - t0
      };
    }
    if (resp.body && typeof resp.body.dump === 'function') {
      await resp.body.dump().catch(() => {});
    }
    return {
      online: false,
      baseUrl,
      statusCode: resp.statusCode,
      latencyMs: Date.now() - t0
    };
  } catch (_) {
    return {
      online: false,
      baseUrl,
      latencyMs: Date.now() - t0
    };
  }
}

/**
 * Cria a instância Express configurada com todas as rotas htmx, SSE, Ollama e Qdrant Vector DB.
 * Aceita dependências injetáveis para testes determinísticos de integração.
 */
function createApp(options = {}) {
  const env = options.env || process.env;
  const db = options.db || createDatabase(options.dbPath);
  const qdrant = options.qdrant || createQdrantStore({ env });
  const searchFn = options.searchFn || searchBrave;
  const extractFn = options.extractFn || extractTopSources;
  const streamAnswerFn = options.streamAnswerFn || streamAnswer;
  const listModelsFn = options.listModelsFn || listOllamaModels;
  const translateTurnFn = options.translateTurnFn || translateTurnMarkdown;
  const checkOllamaFn = options.checkOllamaFn || (() => probeOllamaHealth(env));
  const allowDockerBridge = String(env.ALLOW_DOCKER_BRIDGE || '').trim().toLowerCase() === 'true';

  const app = express();
  app.disable('x-powered-by');

  // Guardião estrito de localhost, anti-DNS Rebinding, anti-CSRF e cabeçalhos de segurança
  app.use((req, res, next) => {
    const remote = req.socket?.remoteAddress || '';
    if (!options.allowNonLoopback && !isLoopbackAddress(remote, allowDockerBridge)) {
      res.status(403).type('text/plain').send('Acesso permitido exclusivamente via localhost (127.0.0.1).');
      return;
    }

    if (!options.allowAnyHost && !isAllowedHostHeader(req.headers.host, req.socket?.localPort, env)) {
      res.status(403).type('text/plain').send('Cabeçalho Host não autorizado.');
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
      if (!isAllowedOrigin(req, env)) {
        res.status(403).json({ ok: false, error: 'Origem cross-site bloqueada (proteção CSRF).' });
        return;
      }
    }

    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));

  // Servir htmx localmente (zero chamadas a CDNs externos; streaming SSE gerenciado por EventSource único em app.js)
  const htmxDistPath = path.join(__dirname, '..', 'node_modules', 'htmx.org', 'dist', 'htmx.min.js');

  app.get('/vendor/htmx.min.js', (_req, res) => {
    res.type('application/javascript').sendFile(htmxDistPath);
  });

  const faviconSvgPath = path.join(__dirname, '..', 'public', 'favicon.svg');
  app.get(['/favicon.ico', '/favicon.svg'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.type('image/svg+xml').sendFile(faviconSvgPath);
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Healthcheck BTM real: verifica SQLite (SELECT 1), Ollama (timeout 1s) e Qdrant
  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const status = getEnvStatus(env);

      let sqliteHealth = { online: false };
      try {
        if (db?.raw && typeof db.raw.prepare === 'function') {
          const row = db.raw.prepare('SELECT 1 AS ok').get();
          sqliteHealth = { online: row?.ok === 1 };
        } else if (typeof db?.listConversations === 'function') {
          db.listConversations();
          sqliteHealth = { online: true };
        }
      } catch (_) {
        sqliteHealth = { online: false };
      }

      const [ollamaHealth, qdrantHealth] = await Promise.all([
        Promise.resolve()
          .then(() => checkOllamaFn({ env }))
          .catch(() => ({ online: false })),
        Promise.resolve()
          .then(() => qdrant.checkHealth())
          .catch(() => ({ online: false }))
      ]);

      const llmReady = status.provider === 'ollama' ? Boolean(ollamaHealth?.online) : Boolean(status.hasLlmKey);
      const overallStatus = sqliteHealth.online && llmReady && Boolean(qdrantHealth?.online) ? 'ok' : 'degraded';

      res.status(sqliteHealth.online ? 200 : 503).json({
        status: overallStatus,
        localhostOnly: !allowDockerBridge && !options.allowNonLoopback,
        telemetry: 'none',
        sqlite: sqliteHealth,
        ollama: ollamaHealth,
        qdrant: qdrantHealth,
        ...status
      });
    })
  );

  // Endpoint de descoberta ao vivo dos modelos instalados no Ollama (/api/models)
  app.get(
    '/api/models',
    asyncHandler(async (_req, res) => {
      const status = getEnvStatus(env);
      const models = await listModelsFn({ env }).catch(() => [
        { name: status.model || 'granite4.2:latest', parameterSize: 'Local' }
      ]);
      res.json({
        provider: status.provider,
        defaultModel: status.model,
        models
      });
    })
  );

  // Endpoints de inspeção e busca vetorial no Qdrant Vector DB
  app.get(
    '/api/qdrant/status',
    asyncHandler(async (_req, res) => {
      const qdrantHealth = await qdrant.checkHealth();
      res.json(qdrantHealth);
    })
  );

  app.get(
    '/api/qdrant/search',
    asyncHandler(async (req, res) => {
      const q = String(req.query?.q || '').trim().slice(0, MAX_QUESTION_LENGTH);
      const limit = parsePositiveInt(req.query?.limit, 8, 1, 30);
      const hits = await qdrant.searchKnowledge(q, limit);
      res.json({ query: q, count: hits.length, hits });
    })
  );

  // Contrato oficial de busca JSON (consumido por crates/deepevil-sdk e clientes locais)
  app.post(
    '/api/search',
    asyncHandler(async (req, res) => {
      const startedAt = Date.now();
      const query = String(req.body?.query || '').trim();
      if (!query) {
        res.status(400).json({ ok: false, error: 'Campo "query" é obrigatório.' });
        return;
      }
      if (query.length > MAX_QUESTION_LENGTH) {
        res.status(400).json({
          ok: false,
          error: `Campo "query" excede o limite máximo de ${MAX_QUESTION_LENGTH} caracteres.`
        });
        return;
      }

      const focus = normalizeFocusMode(req.body?.focus ?? 'general', true);
      const scope = normalizeSearchScope(req.body?.scope || 'global');
      const lang = normalizeSearchLang(req.body?.lang || 'pt-BR');
      const limit = parsePositiveInt(req.body?.limit, 6, 1, 20);
      const effectiveQuery = applyFocusModeToQuery(query, focus);

      const abortController = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      };
      res.on('close', onClose);

      try {
        const searchOutcome = await searchFn(query, {
          env,
          focusMode: focus,
          searchScope: scope,
          searchLang: lang,
          count: limit,
          signal: abortController.signal
        });

        const rawResults = Array.isArray(searchOutcome?.results) ? searchOutcome.results : [];
        const normalizedResults = rawResults
          .slice(0, limit)
          .map((item) => {
            const url = String(item?.url || '').trim();
            const snippet = String(item?.snippet || item?.description || item?.content || '').trim();
            let domain = String(item?.domain || '').trim();
            if (!domain && url) {
              try {
                domain = new URL(url).hostname;
              } catch (_) {
                domain = '';
              }
            }
            const rawTitle = String(item?.title || domain || url).trim();
            const poleMatch = rawTitle.match(/^\[[^\]]*\b(US|CN|DE|JP|KR|RU|BR)\b\]/i);
            const pole = String(item?.pole || item?.countryPole || (poleMatch ? poleMatch[1].toUpperCase() : '') || 'global');
            return {
              title: rawTitle,
              url,
              snippet,
              description: snippet,
              content: snippet,
              domain,
              pole,
              sourceEngine: String(item?.sourceEngine || item?.engine || searchOutcome?.provider || 'deepevil'),
              ...(item?.countryPole ? { countryPole: item.countryPole } : {})
            };
          })
          .filter((item) => item.url);

        res.json({
          query,
          effectiveQuery,
          focus,
          scope,
          lang,
          provider: String(searchOutcome?.provider || 'unknown'),
          durationMs: Date.now() - startedAt,
          results: normalizedResults,
          sources: normalizedResults
        });
      } finally {
        res.off('close', onClose);
      }
    })
  );

  // Página inicial
  app.get(
    '/',
    asyncHandler(async (_req, res) => {
      const conversations = db.listConversations();
      const models = await listModelsFn({ env }).catch(() => []);
      const envStatus = { ...getEnvStatus(env), models };
      res.type('html').send(
        renderFullPage({
          conversations,
          activeConversation: null,
          envStatus
        })
      );
    })
  );

  // Reset para nova conversa (via htmx ou navegação direta)
  app.get(
    '/new',
    asyncHandler(async (req, res) => {
      const conversations = db.listConversations();
      const models = await listModelsFn({ env }).catch(() => []);
      const envStatus = { ...getEnvStatus(env), models };

      if (req.get('HX-Request')) {
        const mainHtml = renderMainStage(null, envStatus);
        const sidebarOob = renderSidebarConversations(conversations, null, true);
        setHxTriggerHeader(res, { 'deepevil:title': { title: 'DeepEvil' } });
        res.type('html').send(`${mainHtml}\n${sidebarOob}`);
        return;
      }

      res.redirect('/');
    })
  );

  // Carregar conversa existente (página inteira ou fragmento htmx)
  const handleLoadConversation = asyncHandler(async (req, res) => {
    const convId = parsePositiveInt(req.params.id, null);
    const activeConversation = convId ? db.getConversationWithTurns(convId) : null;
    const conversations = db.listConversations();
    const models = await listModelsFn({ env }).catch(() => []);
    const envStatus = { ...getEnvStatus(env), models };

    if (!activeConversation) {
      if (req.get('HX-Request')) {
        setHxTriggerHeader(res, { 'deepevil:title': { title: 'DeepEvil' } });
        res.status(404).type('html').send(renderMainStage(null, envStatus));
        return;
      }
      res.redirect('/');
      return;
    }

    if (req.get('HX-Request')) {
      const mainHtml = renderMainStage(activeConversation, envStatus);
      const sidebarOob = renderSidebarConversations(conversations, activeConversation.id, true);
      setHxTriggerHeader(res, { 'deepevil:title': { title: `${activeConversation.title} — DeepEvil` } });
      res.type('html').send(`${mainHtml}\n${sidebarOob}`);
      return;
    }

    res.type('html').send(
      renderFullPage({
        conversations,
        activeConversation,
        envStatus
      })
    );
  });

  app.get('/c/:id', handleLoadConversation);
  app.get('/conversations/:id', handleLoadConversation);

  // Excluir conversa (SQLite + Qdrant Vector DB)
  app.delete(
    '/conversations/:id',
    asyncHandler(async (req, res) => {
      const convId = parsePositiveInt(req.params.id, null);
      if (!convId) {
        res.status(400).json({ ok: false, error: 'ID de conversa inválido.' });
        return;
      }

      let activeConvId = parsePositiveInt(
        req.query?.activeConversationId ?? req.body?.activeConversationId,
        null
      );
      if (!activeConvId) {
        const currentUrl = String(req.get('HX-Current-URL') || '');
        const urlMatch = currentUrl.match(/\/(?:c|conversations)\/(\d+)(?:[/?#]|$)/);
        if (urlMatch) {
          activeConvId = parsePositiveInt(urlMatch[1], null);
        }
      }

      db.deleteConversation(convId);
      await qdrant.deleteConversationPoints(convId).catch(() => {});
      const conversations = db.listConversations();
      const deletedActive = activeConvId !== null && activeConvId === convId;
      const nextActiveId = deletedActive ? null : activeConvId;
      const sidebarHtml = renderSidebarConversations(conversations, nextActiveId, false);

      if (deletedActive && req.get('HX-Request')) {
        const models = await listModelsFn({ env }).catch(() => []);
        const envStatus = { ...getEnvStatus(env), models };
        const mainStageOob = `<main id="main-stage" class="app-main" tabindex="-1" hx-swap-oob="innerHTML">${renderMainStage(null, envStatus)}</main>`;
        res.setHeader('HX-Push-Url', '/');
        setHxTriggerHeader(res, { 'deepevil:title': { title: 'DeepEvil' } });
        res.type('html').send(`${sidebarHtml}\n${mainStageOob}`);
        return;
      }

      res.type('html').send(sidebarHtml);
    })
  );

  const buildTranslatedHtml = (turn, translatedMd, languageLabel, modelName, isCached = false) => {
    const renderedBody = renderAnswerMarkdownWithFootnotes(translatedMd, turn.id, turn.sources || []);
    const cacheTag = isCached ? ' <span class="g-green">[cache 0ms]</span>' : '';
    const badgeHtml = `
      <div class="translated-banner" role="status">
        <span class="g-yellow">●</span>
        <span>Traduzido para <strong>${escapeHtml(languageLabel)}</strong>${cacheTag}</span>
        <span class="meta-sep" aria-hidden="true">·</span>
        <code>${escapeHtml(modelName || 'local')}</code>
      </div>
    `;
    return `${badgeHtml}\n${renderedBody}`;
  };

  // Controle de AbortControllers de streams de tradução para shutdown limpo
  const activeTranslationAborts = new Set();

  // Traduzir resposta de um turno com IA preservando citações [1][2] e fontes (com cache SQLite 0ms)
  app.post(
    '/turns/:turnId/translate',
    asyncHandler(async (req, res) => {
      const turnId = parsePositiveInt(req.params.turnId, null);
      if (!turnId) {
        res.status(400).json({ ok: false, error: 'ID de turno inválido.' });
        return;
      }

      const rawTargetLang =
        req.body?.targetLang === undefined ||
        req.body?.targetLang === null ||
        String(req.body.targetLang).trim() === ''
          ? 'pt-BR'
          : req.body.targetLang;
      const targetLang = validateTargetLang(rawTargetLang, SUPPORTED_TRANSLATION_LANGUAGES);
      if (!targetLang) {
        res.status(400).json({ ok: false, error: 'Idioma de destino inválido ou não suportado.' });
        return;
      }

      const turn = db.getTurn(turnId);
      if (!turn || !turn.answer_markdown) {
        res.status(404).json({ ok: false, error: 'Turno ou resposta não encontrada para tradução.' });
        return;
      }

      const selectedModel = sanitizeModelName(req.body?.model || turn.model || '');
      const languageLabel = SUPPORTED_TRANSLATION_LANGUAGES[targetLang];

      const cached =
        !req.body?.force && typeof db.getTurnTranslation === 'function'
          ? db.getTurnTranslation(turn.id, targetLang)
          : null;

      if (cached && cached.translated_markdown) {
        const html = buildTranslatedHtml(
          turn,
          cached.translated_markdown,
          languageLabel,
          cached.model || selectedModel,
          true
        );
        res.json({
          ok: true,
          cached: true,
          turnId: turn.id,
          targetLang,
          languageLabel,
          model: cached.model || selectedModel,
          translatedMarkdown: cached.translated_markdown,
          html
        });
        return;
      }

      try {
        const result = await translateTurnFn({
          markdownText: turn.answer_markdown,
          targetLang,
          sources: turn.sources || [],
          env,
          selectedModel
        });

        if (typeof db.saveTurnTranslation === 'function' && result.text) {
          db.saveTurnTranslation({
            turnId: turn.id,
            targetLang: result.targetLang || targetLang,
            model: result.model || selectedModel,
            translatedMarkdown: result.text
          });
        }

        const html = buildTranslatedHtml(
          turn,
          result.text,
          result.languageLabel || languageLabel,
          result.model || selectedModel,
          false
        );

        res.json({
          ok: true,
          cached: false,
          turnId: turn.id,
          targetLang: result.targetLang || targetLang,
          languageLabel: result.languageLabel || languageLabel,
          model: result.model,
          translatedMarkdown: result.text,
          html
        });
      } catch (_) {
        res.status(500).json({
          ok: false,
          error: 'Falha ao traduzir resposta com IA.'
        });
      }
    })
  );

  // Streaming SSE em tempo real da tradução com IA (com validação estrita, AbortController e Frame Batching ~40ms)
  app.get(
    '/turns/:turnId/translate/stream',
    asyncHandler(async (req, res) => {
      const turnId = parsePositiveInt(req.params.turnId, null);
      if (!turnId) {
        res.status(400).json({ ok: false, error: 'ID de turno inválido.' });
        return;
      }

      const rawLang =
        req.query?.lang === undefined ||
        req.query?.lang === null ||
        String(req.query.lang).trim() === ''
          ? 'pt-BR'
          : req.query.lang;
      const targetLang = validateTargetLang(rawLang, SUPPORTED_TRANSLATION_LANGUAGES);
      if (!targetLang) {
        res.status(400).json({ ok: false, error: 'Idioma de destino inválido ou não suportado.' });
        return;
      }

      const turn = db.getTurn(turnId);
      const selectedModel = sanitizeModelName(req.query?.model || turn?.model || '');
      const languageLabel = SUPPORTED_TRANSLATION_LANGUAGES[targetLang];

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      if (!turn || !turn.answer_markdown) {
        writeSseEvent(res, 'done', JSON.stringify({ error: true }));
        res.end();
        return;
      }

      const cached =
        typeof db.getTurnTranslation === 'function' ? db.getTurnTranslation(turn.id, targetLang) : null;

      if (cached && cached.translated_markdown) {
        writeSseEvent(
          res,
          'answer',
          buildTranslatedHtml(turn, cached.translated_markdown, languageLabel, cached.model || selectedModel, true)
        );
        writeSseEvent(res, 'done', JSON.stringify({ cached: true, durationMs: 0, targetLang }));
        res.end();
        return;
      }

      const abortController = new AbortController();
      activeTranslationAborts.add(abortController);
      const onClose = () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      };
      res.on('close', onClose);

      const startedAt = Date.now();
      const throttleMs = resolveThrottleMs(env);
      const llmConfig = resolveLlmConfig(env, selectedModel);
      const translateBatcher = createFrameBatcher((sanitizedAccumulated) => {
        if (abortController.signal.aborted || res.writableEnded) return;
        writeSseEvent(
          res,
          'answer',
          buildTranslatedHtml(turn, sanitizedAccumulated, languageLabel, llmConfig.model, false)
        );
      }, throttleMs);

      try {
        const result = await translateTurnFn({
          markdownText: turn.answer_markdown,
          targetLang,
          sources: turn.sources || [],
          env,
          selectedModel: llmConfig.model,
          signal: abortController.signal,
          onDelta: (_delta, sanitizedAccumulated) => {
            if (!abortController.signal.aborted) {
              translateBatcher.push(sanitizedAccumulated);
            }
          }
        });

        translateBatcher.flush();

        if (abortController.signal.aborted) {
          if (!res.writableEnded) {
            writeSseEvent(res, 'done', JSON.stringify({ aborted: true, targetLang }));
            res.end();
          }
          return;
        }

        if (typeof db.saveTurnTranslation === 'function' && result.text) {
          db.saveTurnTranslation({
            turnId: turn.id,
            targetLang: result.targetLang || targetLang,
            model: result.model || llmConfig.model,
            translatedMarkdown: result.text
          });
        }

        const durationMs = Date.now() - startedAt;
        writeSseEvent(
          res,
          'answer',
          buildTranslatedHtml(
            turn,
            result.text,
            result.languageLabel || languageLabel,
            result.model || llmConfig.model,
            false
          )
        );
        writeSseEvent(
          res,
          'done',
          JSON.stringify({ cached: false, durationMs, targetLang: result.targetLang || targetLang })
        );
        res.end();
      } catch (_) {
        translateBatcher.cancel();
        if (!res.writableEnded) {
          writeSseEvent(res, 'done', JSON.stringify({ error: true }));
          res.end();
        }
      } finally {
        translateBatcher.cancel();
        res.off('close', onClose);
        activeTranslationAborts.delete(abortController);
      }
    })
  );

  // Exportar relatório técnico completo do turno em Markdown (.md) com citações e notas de rodapé
  app.get('/turns/:turnId/export.md', (req, res) => {
    const turnId = parsePositiveInt(req.params.turnId, null);
    if (!turnId) {
      res.status(400).type('text/plain').send('ID de turno inválido.');
      return;
    }

    const turn = db.getTurn(turnId);
    if (!turn) {
      res.status(404).type('text/plain').send('Turno não encontrado.');
      return;
    }

    const rawReqLang = String(req.query?.lang || '').trim();
    const reqLang = rawReqLang ? validateTargetLang(rawReqLang, SUPPORTED_TRANSLATION_LANGUAGES) : '';
    if (rawReqLang && !reqLang) {
      res.status(400).type('text/plain').send('Idioma de exportação não suportado.');
      return;
    }

    const cachedTranslation =
      reqLang && typeof db.getTurnTranslation === 'function'
        ? db.getTurnTranslation(turn.id, reqLang)
        : null;

    const bodyMarkdown = cachedTranslation?.translated_markdown || turn.answer_markdown || '*(Sem resposta gerada)*';
    const sources = Array.isArray(turn.sources) ? turn.sources : [];
    const footnotesBlock =
      sources.length > 0
        ? [
            '',
            '---',
            '## Fontes Verificadas (SERP // Readability)',
            '',
            ...sources.map((s, idx) => {
              const cIdx = s.citation_index || s.citationIndex || idx + 1;
              return `- **[${cIdx}] [${s.title || s.domain}](${s.url})** — \`${s.domain}\` (${s.word_count || s.wordCount || 0} palavras)`;
            })
          ].join('\n')
        : '';

    const doc = [
      `# ${turn.question}`,
      '',
      `> **DeepEvil Intelligence Report** · Turno \`#${turn.id}\` · Engine: \`${turn.model || 'local'}\` · Dork: \`${turn.search_query || turn.question}\`${cachedTranslation ? ` · Traduzido (\`${reqLang}\`)` : ''}`,
      '',
      bodyMarkdown,
      footnotesBlock,
      ''
    ].join('\n');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="deepevil-turn-${turn.id}.md"`);
    res.send(doc);
  });

  // Submeter pergunta (inicial ou follow-up mantendo contexto da conversa anterior, Escopo, Focus Mode e LLM escolhida)
  app.post(
    '/ask',
    asyncHandler(async (req, res) => {
      const rawQuestion = String(req.body?.question || '').trim();
      const rawConvId = String(req.body?.conversationId || '').trim();
      const selectedModel = sanitizeModelName(req.body?.model || '');
      const focusMode = normalizeFocusMode(req.body?.focusMode || 'web', false);
      const searchScope = normalizeSearchScope(req.body?.searchScope || 'global');
      const searchLang = normalizeSearchLang(req.body?.searchLang || 'pt-BR');

      if (!rawQuestion) {
        res.status(400).type('html').send(
          '<div class="turn-error-box" role="alert">Por favor, digite uma pergunta válida.</div>'
        );
        return;
      }

      if (rawQuestion.length > MAX_QUESTION_LENGTH) {
        res.status(400).type('html').send(
          `<div class="turn-error-box" role="alert">A pergunta excede o limite máximo de ${MAX_QUESTION_LENGTH} caracteres.</div>`
        );
        return;
      }

      const convId = rawConvId ? parsePositiveInt(rawConvId, null) : null;
      let conversation = convId ? db.getConversation(convId) : null;
      if (!conversation) {
        // A conversa é identificada na barra lateral estritamente pela primeira pergunta feita
        conversation = db.createConversation(rawQuestion);
      }

      const priorTurns = db.getPriorCompletedTurns(conversation.id);
      const searchQuery = buildContextualSearchQuery(rawQuestion, priorTurns, focusMode);
      const llmConfig = resolveLlmConfig(env, selectedModel);

      const turn = db.createTurn({
        conversationId: conversation.id,
        question: rawQuestion,
        searchQuery,
        provider: llmConfig.provider,
        model: llmConfig.model,
        focusMode,
        searchScope,
        searchLang
      });

      const conversations = db.listConversations();
      const turnHtml = renderTurnCard(turn, {
        isLive: true,
        isPrimaryHeading: priorTurns.length === 0
      });
      const sidebarOob = renderSidebarConversations(conversations, conversation.id, true);
      const contextSlotOob = renderComposerContextSlot(conversation, true);
      const removeHeroOob = '<div id="empty-hero" hx-swap-oob="delete"></div>';
      const removeSuggestionsOob = '<div id="hero-suggestions" hx-swap-oob="delete"></div>';

      res.setHeader('HX-Push-Url', `/c/${conversation.id}`);
      setHxTriggerHeader(res, {
        'deepevil:title': { title: `${conversation.title} — DeepEvil` },
        'deepevil:conversation': {
          id: conversation.id,
          title: conversation.title,
          isFollowUp: true
        }
      });
      res.type('html').send(`${turnHtml}\n${sidebarOob}\n${contextSlotOob}\n${removeHeroOob}\n${removeSuggestionsOob}`);
    })
  );

  // Registro de execuções em andamento para evitar chamadas duplicadas à API caso
  // múltiplos clientes SSE se conectem ao mesmo turnId simultaneamente
  const activeTurnStreams = new Map();
  let nextStreamGenerationId = 0;

  // Interromper imediatamente um turno em execução (Stop Generation)
  app.post('/turns/:turnId/stop', (req, res) => {
    const turnId = parsePositiveInt(req.params.turnId, null);
    if (!turnId) {
      res.status(400).json({ ok: false, error: 'ID de turno inválido.' });
      return;
    }
    const active = activeTurnStreams.get(turnId);
    if (active && active.abortController) {
      active.abortController.abort();
      res.json({ ok: true, stopped: true, turnId });
      return;
    }
    res.json({ ok: true, stopped: false, turnId });
  });

  // Regerar / Trocar Modelo reutilizando as fontes já extraídas no SQLite (0ms de busca web)
  app.post('/turns/:turnId/rewrite', (req, res) => {
    const turnId = parsePositiveInt(req.params.turnId, null);
    if (!turnId) {
      res.status(400).json({ ok: false, error: 'ID de turno inválido.' });
      return;
    }

    const turn = db.getTurn(turnId);
    if (!turn) {
      res.status(404).json({ ok: false, error: 'Turno não encontrado.' });
      return;
    }

    // Cleanup síncrono da geração ativa antes de responder 200 OK (elimina race condition)
    const active = activeTurnStreams.get(turnId);
    if (active) {
      active.superseded = true;
      if (active.disconnectTimer) {
        clearTimeout(active.disconnectTimer);
        active.disconnectTimer = null;
      }
      activeTurnStreams.delete(turnId);
      if (active.abortController && !active.abortController.signal.aborted) {
        active.abortController.abort();
      }
      for (const clientRes of active.clients) {
        if (!clientRes.writableEnded) {
          writeSseEvent(clientRes, 'done', 'superseded');
          clientRes.end();
        }
      }
      active.clients.clear();
    }

    const requestedModel = sanitizeModelName(req.body?.model || turn.model || '');
    const llmConfig = resolveLlmConfig(env, requestedModel);
    const updated =
      typeof db.resetTurnForRewrite === 'function'
        ? db.resetTurnForRewrite(turnId, { provider: llmConfig.provider, model: llmConfig.model })
        : turn;

    res.json({
      ok: true,
      turnId: updated.id,
      provider: updated.provider,
      model: updated.model,
      sourcesCount: Array.isArray(updated.sources) ? updated.sources.length : 0
    });
  });

  // Endpoint SSE de Streaming para execução do pipeline:
  // 1) Busca Multi-Motor (SearXNG / Brave / Keyless + Focus Mode)
  // 2) Extração @mozilla/readability + DOM com Early-Cutoff + Snippet Fallback (ou reuso instantâneo no Rewrite)
  // 3) Streaming LLM com Frame Batching (~40ms), citações [1][2] + Hover Cards e suporte a Stop Generation
  app.get(
    '/stream/:turnId',
    asyncHandler(async (req, res) => {
      const turnId = parsePositiveInt(req.params.turnId, null);
      const turn = turnId ? db.getTurn(turnId) : null;

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      if (!turn) {
        writeSseEvent(res, 'status', renderPipelineStatusBadge('error', { errorMessage: 'Turno não encontrado.' }));
        writeSseEvent(res, 'done', 'closed');
        res.end();
        return;
      }

      // Se já foi processado anteriormente, retorna o estado consolidado imediatamente
      if (turn.status === 'completed' || turn.status === 'error') {
        writeSseEvent(
          res,
          'status',
          renderPipelineStatusBadge(turn.status, {
            turnId: turn.id,
            searchQuery: turn.search_query,
            attemptedCount: turn.attempted_urls_count,
            extractedCount: turn.extracted_sources_count,
            provider: turn.provider,
            model: turn.model,
            durationMs: turn.duration_ms,
            errorMessage: turn.error_message
          })
        );
        const consolidatedSourcesHtml = renderTurnSourcesFootnotes(turn.id, turn.sources || [], {
          status: turn.status,
          question: turn.question,
          answerMarkdown: turn.answer_markdown
        });
        writeSseEvent(
          res,
          'sources',
          turn.status === 'completed' ? consolidatedSourcesHtml : stripActionToolbar(consolidatedSourcesHtml)
        );
        writeSseEvent(
          res,
          'answer',
          renderAnswerMarkdownWithFootnotes(turn.answer_markdown, turn.id, turn.sources || [])
        );
        writeSseEvent(res, 'done', 'closed');
        res.end();
        return;
      }

      const disconnectGraceMs = parsePositiveInt(env.SSE_DISCONNECT_GRACE_MS, 1500, 50, 30000);
      const attachClientDisconnect = (state, _clientReq, clientRes) => {
        clientRes.on('close', () => {
          state.clients.delete(clientRes);
          if (state.clients.size === 0 && !state.finished && !state.superseded && !state.disconnectTimer) {
            state.disconnectTimer = setTimeout(() => {
              state.disconnectTimer = null;
              if (state.clients.size === 0 && !state.finished && !state.superseded) {
                state.abortController.abort();
              }
            }, disconnectGraceMs);
            if (typeof state.disconnectTimer.unref === 'function') {
              state.disconnectTimer.unref();
            }
          }
        });
      };

      // Se já existe um pipeline rodando para este turnId, apenas inscreve a resposta atual
      if (activeTurnStreams.has(turnId)) {
        const state = activeTurnStreams.get(turnId);
        if (state.disconnectTimer) {
          clearTimeout(state.disconnectTimer);
          state.disconnectTimer = null;
        }
        state.clients.add(res);
        if (state.lastStatus) writeSseEvent(res, 'status', state.lastStatus);
        if (state.lastSources) writeSseEvent(res, 'sources', state.lastSources);
        if (state.lastAnswer) writeSseEvent(res, 'answer', state.lastAnswer);
        attachClientDisconnect(state, req, res);
        return;
      }

      const generationId = ++nextStreamGenerationId;
      const abortController = new AbortController();
      const streamState = {
        generationId,
        clients: new Set([res]),
        abortController,
        disconnectTimer: null,
        finished: false,
        superseded: false,
        lastStatus: null,
        lastSources: null,
        lastAnswer: null
      };
      activeTurnStreams.set(turnId, streamState);
      attachClientDisconnect(streamState, req, res);

      const isCurrentGeneration = () =>
        !streamState.superseded && activeTurnStreams.get(turnId)?.generationId === generationId;

      const broadcastSse = (eventName, htmlPayload) => {
        if (streamState.superseded) return;
        if (eventName === 'status') streamState.lastStatus = htmlPayload;
        if (eventName === 'sources') streamState.lastSources = htmlPayload;
        if (eventName === 'answer') streamState.lastAnswer = htmlPayload;

        for (const clientRes of streamState.clients) {
          writeSseEvent(clientRes, eventName, htmlPayload);
        }
      };

      const closeAllClients = () => {
        streamState.finished = true;
        if (streamState.disconnectTimer) {
          clearTimeout(streamState.disconnectTimer);
          streamState.disconnectTimer = null;
        }
        for (const clientRes of streamState.clients) {
          if (!clientRes.writableEnded) {
            clientRes.end();
          }
        }
        streamState.clients.clear();
        if (activeTurnStreams.get(turnId) === streamState) {
          activeTurnStreams.delete(turnId);
        }
      };

      const startedAt = Date.now();
      const throttleMs = resolveThrottleMs(env);
      let answerBatcher = null;

      try {
        let validSources = Array.isArray(turn.sources) ? turn.sources : [];
        let attemptedUrlsCount = Number(turn.attempted_urls_count || validSources.length);
        const isRewriteWithCachedSources = turn.status === 'streaming' && validSources.length > 0;
        const searchPlan =
          typeof planSearchIntent === 'function'
            ? planSearchIntent(turn.question, {
                focusMode: turn.focus_mode || 'web',
                searchScope: turn.search_scope || 'global',
                searchLang: turn.search_lang || 'pt-BR'
              })
            : { intent: 'deep_research', freshness: 'any' };

        if (!isRewriteWithCachedSources) {
          // ETAPA 1: Consulta Busca Web (e em paralelo Qdrant caso focus_mode === 'hybrid')
          db.updateTurnStatus(turn.id, 'searching', { searchQuery: turn.search_query });
          broadcastSse(
            'status',
            renderPipelineStatusBadge('searching', {
              turnId: turn.id,
              searchQuery: turn.search_query
            })
          );

          const hybridPromise =
            turn.focus_mode === 'hybrid' && typeof qdrant.searchHybridSources === 'function'
              ? qdrant.searchHybridSources(turn.question, 2).catch(() => [])
              : Promise.resolve([]);

          const [searchOutcome, hybridLocalSources] = await Promise.all([
            searchFn(turn.search_query, {
              env,
              focusMode: turn.focus_mode || 'web',
              searchScope: turn.search_scope || 'global',
              searchLang: turn.search_lang || 'pt-BR',
              signal: abortController.signal
            }),
            hybridPromise
          ]);

          if (!isCurrentGeneration()) {
            closeAllClients();
            return;
          }

          const searchResults = Array.isArray(searchOutcome?.results)
            ? searchOutcome.results.slice(0, 12)
            : [];

          // ETAPA 2: Extração legível com Early-Cutoff + Query-Focused Passage Selection
          db.updateTurnStatus(turn.id, 'extracting', {
            attemptedUrlsCount: searchResults.length
          });
          broadcastSse(
            'status',
            renderPipelineStatusBadge('extracting', {
              turnId: turn.id,
              attemptedCount: searchResults.length
            })
          );

          const extraction = await extractFn(searchResults, {
            env,
            query: turn.question,
            signal: abortController.signal
          });

          if (!isCurrentGeneration()) {
            closeAllClients();
            return;
          }

          const webSources = Array.isArray(extraction?.sources) ? extraction.sources : [];
          attemptedUrlsCount = extraction?.attemptedCount ?? searchResults.length;

          const combinedSources = [...webSources];
          if (Array.isArray(hybridLocalSources) && hybridLocalSources.length > 0) {
            for (const hs of hybridLocalSources) {
              if (combinedSources.length >= 12) break;
              if (!combinedSources.some((s) => s.url === hs.url)) {
                combinedSources.push(hs);
              }
            }
          }

          const indexedSources = combinedSources.map((src, idx) => ({
            ...src,
            citationIndex: idx + 1
          }));

          validSources = indexedSources;
          db.saveTurnSources(turn.id, validSources);
          db.updateTurnStatus(turn.id, 'streaming', {
            attemptedUrlsCount,
            extractedSourcesCount: validSources.length
          });

          // Traduz automaticamente os assuntos/headlines das fontes internacionais
          // EM PARALELO com o prefill da LLM (elimina 1.5s-3.0s de espera bloqueante antes do 1º token)
          if (extractFn === extractTopSources && indexedSources.length > 0) {
            localizeSourceHeadlines(indexedSources, turn.search_lang || 'pt-BR', {
              signal: abortController.signal
            })
              .then((localized) => {
                if (!isCurrentGeneration() || !Array.isArray(localized) || localized.length === 0) return;
                validSources = localized;
                db.saveTurnSources(turn.id, validSources);
                broadcastSse(
                  'sources',
                  stripActionToolbar(
                    renderTurnSourcesFootnotes(turn.id, validSources, {
                      status: 'streaming',
                      question: turn.question
                    })
                  )
                );
              })
              .catch(() => {});
          }
        }

        // Envia a lista de fontes durante streaming SEM actionToolbarHtml (evita ações prematuras)
        broadcastSse(
          'sources',
          stripActionToolbar(
            renderTurnSourcesFootnotes(turn.id, validSources, { status: 'streaming', question: turn.question })
          )
        );
        broadcastSse('answer', renderAnswerMarkdownWithFootnotes('', turn.id, validSources));

        const llmConfig = resolveLlmConfig(env, turn.model);
        broadcastSse(
          'status',
          renderPipelineStatusBadge('streaming', {
            turnId: turn.id,
            provider: llmConfig.provider,
            model: llmConfig.model,
            extractedCount: validSources.length
          })
        );

        // ETAPA 3: Contexto de follow-up + Streaming LLM com Frame Batching (~40ms)
        const priorTurns = db.getPriorCompletedTurns(turn.conversation_id, turn.id);
        answerBatcher = createFrameBatcher((sanitizedText) => {
          if (!isCurrentGeneration()) return;
          const renderedHtml = renderAnswerMarkdownWithFootnotes(sanitizedText, turn.id, validSources);
          broadcastSse('answer', renderedHtml);
        }, throttleMs);

        const llmResult = await streamAnswerFn({
          question: turn.question,
          sources: validSources,
          priorTurns,
          env,
          selectedModel: turn.model || llmConfig.model,
          searchLang: turn.search_lang || 'pt-BR',
          focusMode: turn.focus_mode || 'web',
          intent: searchPlan?.intent,
          signal: abortController.signal,
          onDelta: (_delta, sanitizedAccumulated) => {
            if (isCurrentGeneration()) {
              answerBatcher.push(sanitizedAccumulated);
            }
          }
        });

        answerBatcher.flush();

        if (!isCurrentGeneration()) {
          closeAllClients();
          return;
        }

        const finalMarkdown = llmResult.aborted
          ? `${String(llmResult.text || '').trim()}\n\n*(Geração interrompida pelo operador)*`.trim()
          : llmResult.text;

        const groundingReport =
          typeof verifyCitationGrounding === 'function'
            ? verifyCitationGrounding(finalMarkdown, validSources)
            : null;
        const lowFidelity = Boolean(
          groundingReport && groundingReport.totalCitations > 0 && groundingReport.faithfulnessScore < 0.5
        );
        if (lowFidelity) {
          console.warn(
            `[DeepEvil] Alerta de baixa fidelidade de citações no turno #${turn.id}: score=${groundingReport.faithfulnessScore} (${groundingReport.verifiedCitations}/${groundingReport.totalCitations})`
          );
        }

        const durationMs = Date.now() - startedAt;
        const completedTurn = db.completeTurn(turn.id, {
          answerMarkdown: finalMarkdown,
          provider: llmResult.provider || llmConfig.provider,
          model: llmResult.model || llmConfig.model,
          attemptedUrlsCount,
          extractedSourcesCount: validSources.length,
          durationMs
        });

        // Emite os eventos finais consolidados (com actionToolbarHtml agora que status === 'completed') e encerra o SSE
        broadcastSse(
          'answer',
          renderAnswerMarkdownWithFootnotes(completedTurn.answer_markdown, turn.id, validSources)
        );
        broadcastSse(
          'sources',
          renderTurnSourcesFootnotes(turn.id, validSources, {
            status: 'completed',
            question: turn.question,
            answerMarkdown: completedTurn.answer_markdown
          })
        );
        broadcastSse(
          'status',
          renderPipelineStatusBadge('completed', {
            turnId: turn.id,
            attemptedCount: completedTurn.attempted_urls_count,
            extractedCount: completedTurn.extracted_sources_count,
            provider: completedTurn.provider,
            model: completedTurn.model,
            durationMs: completedTurn.duration_ms
          })
        );
        broadcastSse('done', 'closed');
        closeAllClients();

        // ETAPA 4: Indexação vetorial assíncrona fire-and-forget no Qdrant Vector DB
        // Executada DEPOIS de emitir `done` para nunca travar a conclusão visual do turno
        const parentConversation = db.getConversation(turn.conversation_id);
        Promise.resolve(
          qdrant.indexTurn({
            conversation: parentConversation,
            turn: completedTurn,
            sources: validSources,
            citationVerification: groundingReport,
            lowFidelity,
            groundingScore: groundingReport?.faithfulnessScore
          })
        ).catch((indexErr) => {
          console.warn('[DeepEvil] Falha não-bloqueante ao indexar turno no Qdrant:', indexErr?.message || indexErr);
        });
      } catch (err) {
        if (answerBatcher) {
          answerBatcher.cancel();
        }
        if (!isCurrentGeneration()) {
          closeAllClients();
          return;
        }

        const durationMs = Date.now() - startedAt;
        const message = err?.message || String(err);
        db.failTurn(turn.id, message, durationMs);

        broadcastSse('status', renderPipelineStatusBadge('error', { turnId: turn.id, errorMessage: message }));
        broadcastSse(
          'answer',
          `<div class="turn-error-box" role="alert"><strong>Falha ao gerar resposta:</strong> ${escapeHtml(message)}</div>`
        );
        const failedTurn = db.getTurn(turn.id);
        broadcastSse(
          'sources',
          renderTurnSourcesFootnotes(turn.id, failedTurn?.sources || [], {
            status: 'error',
            question: turn.question
          })
        );
        broadcastSse('done', 'closed');
        closeAllClients();
      }
    })
  );

  // Middleware global de tratamento de erros (sem vazamento de stack trace ou HTML cru)
  app.use((err, req, res, _next) => {
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    let statusCode = 500;
    let clientMessage = 'Erro interno no servidor.';

    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
      statusCode = 400;
      clientMessage = 'Payload JSON inválido.';
    } else if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      statusCode = 413;
      clientMessage = 'Payload excede o tamanho máximo permitido.';
    } else if (Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
      statusCode = err.statusCode;
      clientMessage = err.expose ? String(err.message || 'Requisição inválida.') : 'Requisição inválida.';
    } else {
      console.error('[DeepEvil] Erro interno não tratado:', err?.message || err);
    }

    const wantsJson =
      req.path.startsWith('/api/') ||
      req.is('application/json') ||
      (String(req.get('Accept') || '').includes('application/json') && !req.get('HX-Request'));

    if (wantsJson) {
      res.status(statusCode).json({ ok: false, error: clientMessage });
      return;
    }

    res
      .status(statusCode)
      .type('html')
      .send(`<div class="turn-error-box" role="alert">${escapeHtml(clientMessage)}</div>`);
  });

  app.locals.db = db;
  app.locals.qdrant = qdrant;
  app.locals.abortActiveStreams = () => {
    for (const [turnId, state] of activeTurnStreams.entries()) {
      state.superseded = true;
      state.finished = true;
      if (state.disconnectTimer) {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = null;
      }
      if (state.abortController && !state.abortController.signal.aborted) {
        state.abortController.abort();
      }
      for (const clientRes of state.clients) {
        if (!clientRes.writableEnded) {
          writeSseEvent(clientRes, 'done', 'shutdown');
          clientRes.end();
        }
      }
      state.clients.clear();
      activeTurnStreams.delete(turnId);
    }
    for (const controller of activeTranslationAborts) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
    activeTranslationAborts.clear();
  };

  return app;
}

if (require.main === module) {
  const port = parsePositiveInt(process.env.PORT, 3000, 1, 65535);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();

  const server = app.listen(port, host, () => {
    console.log(`Perplexity Local rodando exclusivamente em http://${host}:${port} (localhost:${port})`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && host === '127.0.0.1') {
      console.error(
        `Porta ${port} já está ocupada em 127.0.0.1. Feche o processo que utiliza a porta ${port} ou defina PORT no .env.`
      );
    } else {
      console.error('Erro ao iniciar servidor:', err);
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const gracefulShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[DeepEvil] Sinal ${signal} recebido. Abortando streams ativos e encerrando servidor...`);

    try {
      if (typeof app.locals.abortActiveStreams === 'function') {
        app.locals.abortActiveStreams();
      }
      if (typeof cleanupWslKeepAlive === 'function') {
        cleanupWslKeepAlive();
      }
    } catch (_) {}

    const closeDatabase = () => {
      try {
        if (typeof app.locals.db?.checkpointAndClose === 'function') {
          app.locals.db.checkpointAndClose();
        } else if (typeof app.locals.db?.close === 'function') {
          app.locals.db.close();
        }
      } catch (err) {
        console.error('[DeepEvil] Falha ao encerrar SQLite:', err?.message || err);
      }
    };

    const forceTimer = setTimeout(() => {
      closeDatabase();
      process.exit(0);
    }, 5000);
    if (typeof forceTimer.unref === 'function') {
      forceTimer.unref();
    }

    server.close(() => {
      clearTimeout(forceTimer);
      closeDatabase();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = {
  createApp,
  createFrameBatcher,
  getEnvStatus,
  isLoopbackAddress
};
