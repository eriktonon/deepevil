'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { createDatabase } = require('./db');
const { createQdrantStore } = require('./qdrant');
const { buildContextualSearchQuery, searchBrave } = require('./search');
const { extractTopSources } = require('./extractor');
const { resolveLlmConfig, listOllamaModels, streamAnswer, translateTurnMarkdown } = require('./llm');
const {
  escapeHtml,
  renderAnswerMarkdownWithFootnotes,
  renderTurnSourcesFootnotes,
  renderPipelineStatusBadge,
  renderTurnCard,
  renderSidebarConversations,
  renderComposerForm,
  renderMainStage,
  renderFullPage
} = require('./render');

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

function isLoopbackAddress(remoteAddress = '') {
  if (!remoteAddress) return true;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress.startsWith('127.') ||
    remoteAddress.startsWith('::ffff:127.')
  );
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

  const app = express();
  app.disable('x-powered-by');

  // Guardião estrito de localhost e cabeçalhos de privacidade sem telemetria
  app.use((req, res, next) => {
    const remote = req.socket?.remoteAddress || '';
    if (!options.allowNonLoopback && !isLoopbackAddress(remote)) {
      res.status(403).type('text/plain').send('Acesso permitido exclusivamente via localhost (127.0.0.1).');
      return;
    }

    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));

  // Servir htmx e extensão SSE localmente (zero chamadas a CDNs externos)
  const htmxDistPath = path.join(__dirname, '..', 'node_modules', 'htmx.org', 'dist', 'htmx.min.js');
  const sseDistPath = path.join(__dirname, '..', 'node_modules', 'htmx-ext-sse', 'dist', 'sse.min.js');

  app.get('/vendor/htmx.min.js', (_req, res) => {
    res.type('application/javascript').sendFile(htmxDistPath);
  });

  app.get('/vendor/sse.js', (_req, res) => {
    res.type('application/javascript').sendFile(sseDistPath);
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Healthcheck local + status Qdrant Vector DB
  app.get('/health', async (_req, res) => {
    const status = getEnvStatus(env);
    const qdrantHealth = await qdrant.checkHealth().catch(() => ({ online: false }));
    res.json({
      status: 'ok',
      localhostOnly: true,
      telemetry: 'none',
      qdrant: qdrantHealth,
      ...status
    });
  });

  // Endpoint de descoberta ao vivo dos modelos instalados no Ollama (/api/models)
  app.get('/api/models', async (_req, res) => {
    const status = getEnvStatus(env);
    const models = await listModelsFn({ env }).catch(() => [
      { name: status.model || 'granite4.2:latest', parameterSize: 'Local' }
    ]);
    res.json({
      provider: status.provider,
      defaultModel: status.model,
      models
    });
  });

  // Endpoints de inspeção e busca vetorial no Qdrant Vector DB
  app.get('/api/qdrant/status', async (_req, res) => {
    const qdrantHealth = await qdrant.checkHealth();
    res.json(qdrantHealth);
  });

  app.get('/api/qdrant/search', async (req, res) => {
    const q = String(req.query?.q || '').trim();
    const limit = Math.min(Math.max(Number(req.query?.limit || 8), 1), 30);
    const hits = await qdrant.searchKnowledge(q, limit);
    res.json({ query: q, count: hits.length, hits });
  });

  // Página inicial
  app.get('/', async (_req, res) => {
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
  });

  // Reset para nova conversa (via htmx ou navegação direta)
  app.get('/new', async (req, res) => {
    const conversations = db.listConversations();
    const models = await listModelsFn({ env }).catch(() => []);
    const envStatus = { ...getEnvStatus(env), models };

    if (req.get('HX-Request')) {
      const mainHtml = renderMainStage(null, envStatus);
      const sidebarOob = renderSidebarConversations(conversations, null, true);
      res.type('html').send(`${mainHtml}\n${sidebarOob}`);
      return;
    }

    res.redirect('/');
  });

  // Carregar conversa existente (página inteira ou fragmento htmx)
  const handleLoadConversation = async (req, res) => {
    const convId = Number(req.params.id);
    const activeConversation = db.getConversationWithTurns(convId);
    const conversations = db.listConversations();
    const models = await listModelsFn({ env }).catch(() => []);
    const envStatus = { ...getEnvStatus(env), models };

    if (!activeConversation) {
      if (req.get('HX-Request')) {
        res.status(404).type('html').send(renderMainStage(null, envStatus));
        return;
      }
      res.redirect('/');
      return;
    }

    if (req.get('HX-Request')) {
      const mainHtml = renderMainStage(activeConversation, envStatus);
      const sidebarOob = renderSidebarConversations(conversations, activeConversation.id, true);
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
  };

  app.get('/c/:id', handleLoadConversation);
  app.get('/conversations/:id', handleLoadConversation);

  // Excluir conversa (SQLite + Qdrant Vector DB)
  app.delete('/conversations/:id', async (req, res) => {
    const convId = Number(req.params.id);
    db.deleteConversation(convId);
    await qdrant.deleteConversationPoints(convId).catch(() => {});
    const conversations = db.listConversations();
    res.type('html').send(renderSidebarConversations(conversations, null, false));
  });

  // Traduzir resposta de um turno com IA preservando citações [1][2] e fontes
  app.post('/turns/:turnId/translate', async (req, res) => {
    const turnId = Number(req.params.turnId);
    const turn = db.getTurn(turnId);

    if (!turn || !turn.answer_markdown) {
      res.status(404).json({ ok: false, error: 'Turno ou resposta não encontrada para tradução.' });
      return;
    }

    const targetLang = String(req.body?.targetLang || 'pt-BR').trim();
    const selectedModel = String(req.body?.model || turn.model || '').trim();

    try {
      const result = await translateTurnFn({
        markdownText: turn.answer_markdown,
        targetLang,
        sources: turn.sources || [],
        env,
        selectedModel
      });

      const renderedBody = renderAnswerMarkdownWithFootnotes(result.text, turn.id, turn.sources || []);
      const badgeHtml = `
        <div class="translated-banner" role="status">
          <span class="g-yellow">●</span>
          <span>Traduzido com IA para <strong>${escapeHtml(result.languageLabel)}</strong></span>
          <span class="meta-sep" aria-hidden="true">·</span>
          <code>${escapeHtml(result.model || selectedModel || 'local')}</code>
        </div>
      `;
      const html = `${badgeHtml}\n${renderedBody}`;

      res.json({
        ok: true,
        turnId: turn.id,
        targetLang: result.targetLang,
        languageLabel: result.languageLabel,
        model: result.model,
        translatedMarkdown: result.text,
        html
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err?.message || 'Falha ao traduzir resposta com IA.'
      });
    }
  });

  // Submeter pergunta (inicial ou follow-up mantendo contexto da conversa anterior e LLM escolhida)
  app.post('/ask', async (req, res) => {
    const rawQuestion = String(req.body?.question || '').trim();
    const rawConvId = String(req.body?.conversationId || '').trim();
    const selectedModel = String(req.body?.model || '').trim();

    if (!rawQuestion) {
      res.status(400).type('html').send(
        '<div class="turn-error-box" role="alert">Por favor, digite uma pergunta válida.</div>'
      );
      return;
    }

    let conversation = rawConvId ? db.getConversation(Number(rawConvId)) : null;
    if (!conversation) {
      // A conversa é identificada na barra lateral estritamente pela primeira pergunta feita
      conversation = db.createConversation(rawQuestion);
    }

    const priorTurns = db.getPriorCompletedTurns(conversation.id);
    const searchQuery = buildContextualSearchQuery(rawQuestion, priorTurns);
    const llmConfig = resolveLlmConfig(env, selectedModel);

    const turn = db.createTurn({
      conversationId: conversation.id,
      question: rawQuestion,
      searchQuery,
      provider: llmConfig.provider,
      model: llmConfig.model
    });

    const models = await listModelsFn({ env }).catch(() => []);
    const conversations = db.listConversations();
    const turnHtml = renderTurnCard(turn, { isLive: true });
    const sidebarOob = renderSidebarConversations(conversations, conversation.id, true);
    const composerOob = renderComposerForm(conversation, true, {
      models,
      activeModel: llmConfig.model
    });
    const removeHeroOob = '<div id="empty-hero" hx-swap-oob="delete"></div>';

    res.setHeader('HX-Push-Url', `/c/${conversation.id}`);
    res.type('html').send(
      `${turnHtml}\n${sidebarOob}\n${composerOob}\n${removeHeroOob}`
    );
  });

  // Registro de execuções em andamento para evitar chamadas duplicadas à API caso
  // múltiplos clientes SSE se conectem ao mesmo turnId simultaneamente
  const activeTurnStreams = new Map();

  // Endpoint SSE de Streaming para execução do pipeline:
  // 1) Brave Search (top 6 via undici)
  // 2) Extração @mozilla/readability + jsdom (ignorando falhas)
  // 3) Streaming LLM (Claude ou GPT) com citações [1][2] e contexto de follow-up
  app.get('/stream/:turnId', async (req, res) => {
    const turnId = Number(req.params.turnId);
    const turn = db.getTurn(turnId);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const writeSseToRes = (targetRes, eventName, htmlPayload) => {
      if (targetRes.writableEnded) return;
      const singleLineData = String(htmlPayload || '').replace(/\r?\n/g, ' ');
      targetRes.write(`event: ${eventName}\ndata: ${singleLineData}\n\n`);
    };

    if (!turn) {
      writeSseToRes(res, 'status', renderPipelineStatusBadge('error', { errorMessage: 'Turno não encontrado.' }));
      writeSseToRes(res, 'done', 'closed');
      res.end();
      return;
    }

    // Se já foi processado anteriormente, retorna o estado consolidado imediatamente
    if (turn.status === 'completed' || turn.status === 'error') {
      writeSseToRes(
        res,
        'status',
        renderPipelineStatusBadge(turn.status, {
          searchQuery: turn.search_query,
          attemptedCount: turn.attempted_urls_count,
          extractedCount: turn.extracted_sources_count,
          provider: turn.provider,
          model: turn.model,
          durationMs: turn.duration_ms,
          errorMessage: turn.error_message
        })
      );
      writeSseToRes(res, 'sources', renderTurnSourcesFootnotes(turn.id, turn.sources || [], { status: turn.status, question: turn.question }));
      writeSseToRes(res, 'answer', renderAnswerMarkdownWithFootnotes(turn.answer_markdown, turn.id, turn.sources || []));
      writeSseToRes(res, 'done', 'closed');
      res.end();
      return;
    }

    // Se já existe um pipeline rodando para este turnId, apenas inscreve a resposta atual
    if (activeTurnStreams.has(turnId)) {
      const state = activeTurnStreams.get(turnId);
      state.clients.add(res);
      if (state.lastStatus) writeSseToRes(res, 'status', state.lastStatus);
      if (state.lastSources) writeSseToRes(res, 'sources', state.lastSources);
      if (state.lastAnswer) writeSseToRes(res, 'answer', state.lastAnswer);
      req.on('close', () => {
        state.clients.delete(res);
      });
      return;
    }

    const streamState = {
      clients: new Set([res]),
      lastStatus: null,
      lastSources: null,
      lastAnswer: null
    };
    activeTurnStreams.set(turnId, streamState);

    req.on('close', () => {
      streamState.clients.delete(res);
    });

    const broadcastSse = (eventName, htmlPayload) => {
      if (eventName === 'status') streamState.lastStatus = htmlPayload;
      if (eventName === 'sources') streamState.lastSources = htmlPayload;
      if (eventName === 'answer') streamState.lastAnswer = htmlPayload;

      for (const clientRes of streamState.clients) {
        writeSseToRes(clientRes, eventName, htmlPayload);
      }
    };

    const closeAllClients = () => {
      for (const clientRes of streamState.clients) {
        if (!clientRes.writableEnded) {
          clientRes.end();
        }
      }
      streamState.clients.clear();
      activeTurnStreams.delete(turnId);
    };

    const startedAt = Date.now();

    try {
      // ETAPA 1: Consulta Brave Search API (top 6 resultados via undici)
      db.updateTurnStatus(turn.id, 'searching', { searchQuery: turn.search_query });
      broadcastSse(
        'status',
        renderPipelineStatusBadge('searching', { searchQuery: turn.search_query })
      );

      const searchOutcome = await searchFn(turn.search_query, { env });
      const searchResults = Array.isArray(searchOutcome?.results)
        ? searchOutcome.results.slice(0, 6)
        : [];

      // ETAPA 2: Extração legível com undici + @mozilla/readability + jsdom
      // Páginas que falharem são ignoradas; apenas páginas extraídas com sucesso são numeradas [1]..[K]
      db.updateTurnStatus(turn.id, 'extracting', {
        attemptedUrlsCount: searchResults.length
      });
      broadcastSse(
        'status',
        renderPipelineStatusBadge('extracting', {
          attemptedCount: searchResults.length
        })
      );

      const extraction = await extractFn(searchResults, { env });
      const validSources = Array.isArray(extraction?.sources) ? extraction.sources : [];

      db.saveTurnSources(turn.id, validSources);
      db.updateTurnStatus(turn.id, 'streaming', {
        attemptedUrlsCount: extraction.attemptedCount ?? searchResults.length,
        extractedSourcesCount: validSources.length
      });

      // Envia imediatamente a lista completa de fontes obtidas com sucesso para o rodapé da resposta
      broadcastSse(
        'sources',
        renderTurnSourcesFootnotes(turn.id, validSources, { status: 'streaming', question: turn.question })
      );

      const llmConfig = resolveLlmConfig(env, turn.model);
      broadcastSse(
        'status',
        renderPipelineStatusBadge('streaming', {
          provider: llmConfig.provider,
          model: llmConfig.model,
          extractedCount: validSources.length
        })
      );

      // ETAPA 3: Contexto de follow-up + Streaming do modelo LLM escolhido com citações [1][2]
      const priorTurns = db.getPriorCompletedTurns(turn.conversation_id, turn.id);

      const llmResult = await streamAnswerFn({
        question: turn.question,
        sources: validSources,
        priorTurns,
        env,
        selectedModel: turn.model || llmConfig.model,
        onDelta: (_delta, sanitizedAccumulated) => {
          const renderedHtml = renderAnswerMarkdownWithFootnotes(
            sanitizedAccumulated,
            turn.id,
            validSources
          );
          broadcastSse('answer', renderedHtml);
        }
      });

      const durationMs = Date.now() - startedAt;
      const completedTurn = db.completeTurn(turn.id, {
        answerMarkdown: llmResult.text,
        provider: llmResult.provider || llmConfig.provider,
        model: llmResult.model || llmConfig.model,
        attemptedUrlsCount: extraction.attemptedCount ?? searchResults.length,
        extractedSourcesCount: validSources.length,
        durationMs
      });

      // ETAPA 4: Indexação vetorial imediata no Qdrant Vector DB (Dual-Persistence: Qdrant + SQLite)
      const parentConversation = db.getConversation(turn.conversation_id);
      await qdrant
        .indexTurn({
          conversation: parentConversation,
          turn: completedTurn,
          sources: validSources
        })
        .catch(() => {});

      // Emite os eventos finais consolidados e encerra o stream SSE
      broadcastSse(
        'answer',
        renderAnswerMarkdownWithFootnotes(completedTurn.answer_markdown, turn.id, validSources)
      );
      broadcastSse(
        'sources',
        renderTurnSourcesFootnotes(turn.id, validSources, { status: 'completed', question: turn.question })
      );
      broadcastSse(
        'status',
        renderPipelineStatusBadge('completed', {
          attemptedCount: completedTurn.attempted_urls_count,
          extractedCount: completedTurn.extracted_sources_count,
          provider: completedTurn.provider,
          model: completedTurn.model,
          durationMs: completedTurn.duration_ms
        })
      );
      broadcastSse('done', 'closed');
      closeAllClients();
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err?.message || String(err);
      db.failTurn(turn.id, message, durationMs);

      broadcastSse(
        'status',
        renderPipelineStatusBadge('error', { errorMessage: message })
      );
      broadcastSse(
        'answer',
        `<div class="turn-error-box" role="alert"><strong>Falha ao gerar resposta:</strong> ${message}</div>`
      );
      broadcastSse('done', 'closed');
      closeAllClients();
    }
  });

  app.locals.db = db;
  app.locals.qdrant = qdrant;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
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
}

module.exports = {
  createApp,
  getEnvStatus,
  isLoopbackAddress
};
