'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');

const { createDatabase } = require('../src/db');
const {
  FOCUS_MODES,
  applyFocusModeToQuery,
  searchBrave,
  searchKeylessWeb,
  buildContextualSearchQuery,
  toGlobalResearchQuery,
  buildMultiPolarQueries,
  isExplicitBrazilQuery,
  isPortugueseOrBrazilianBubbleResult,
  scoreResultCoherence,
  normalizeTopResults,
  selectMultiPolarTopResults,
  reconstructOpenAlexAbstract
} = require('../src/search');
const { extractReadablePage, extractTopSources, buildSnippetFallbackSource } = require('../src/extractor');
const { projectVectorToDim, embedTextSemantic } = require('../src/qdrant');
const {
  resolveLlmConfig,
  buildConversationMessages,
  sanitizeCitations,
  streamAnswer
} = require('../src/llm');
const {
  extractKeyConceptsFromTurn,
  buildContextualFollowUps,
  renderAnswerMarkdownWithFootnotes,
  renderTurnSourcesFootnotes,
  renderPipelineStatusBadge
} = require('../src/render');
const { createApp, createFrameBatcher } = require('../src/server');

function makeRichArticleHtml(title, bodyParagraph) {
  return `<!DOCTYPE html>
  <html lang="pt-BR">
    <head><title>${title}</title></head>
    <body>
      <main>
        <article>
          <h1>${title}</h1>
          <p>${bodyParagraph}</p>
          <p>${bodyParagraph}</p>
        </article>
      </main>
    </body>
  </html>`;
}

test('1. Brave Search via undici obtém exatamente os 6 principais resultados e ignora falhas com segurança', async () => {
  const mockApiItems = Array.from({ length: 9 }, (_, i) => ({
    url: `https://exemplo-${i + 1}.org/artigo`,
    title: `Artigo Técnico ${i + 1}`,
    description: `Resumo do artigo ${i + 1}`
  }));

  let capturedHeaders = null;
  const mockRequestFn = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return {
      statusCode: 200,
      body: {
        json: async () => ({ web: { results: mockApiItems } })
      }
    };
  };

  const res = await searchBrave('arquitetura sqlite wal', {
    apiKey: 'brave_test_key_123',
    requestFn: mockRequestFn
  });

  assert.equal(res.error, null);
  assert.equal(res.results.length, 6, 'Deve limitar aos 6 principais resultados');
  assert.equal(capturedHeaders['X-Subscription-Token'], 'brave_test_key_123');
  assert.equal(res.results[0].url, 'https://exemplo-1.org/artigo');
  assert.equal(res.results[5].url, 'https://exemplo-6.org/artigo');

  // Caso a busca falhe, não deve lançar exceção não tratada
  const failedSearch = await searchBrave('teste falha', {
    apiKey: 'brave_test_key_123',
    requestFn: async () => {
      throw new Error('Timeout de rede simulado');
    }
  });
  assert.deepEqual(failedSearch.results, []);
  assert.match(failedSearch.error, /Timeout de rede simulado/);

  // Caso BRAVE_SEARCH_API_KEY seja "keyless" ou vazio, aciona o fallback sem chave via undici + jsdom
  const keylessHtml = `<!DOCTYPE html><html><body>
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://sqlite.org/wal.html')}">Write-Ahead Logging - SQLite</a>
    <a class="result__a" href="https://htmx.org/docs/">htmx Documentation</a>
  </body></html>`;

  const keylessRes = await searchBrave('sqlite wal', {
    apiKey: 'keyless',
    requestFn: async () => ({
      statusCode: 200,
      body: { text: async () => keylessHtml }
    })
  });
  assert.equal(keylessRes.provider, 'keyless-web');
  assert.equal(keylessRes.results.length, 2);
  assert.equal(keylessRes.results[0].url, 'https://sqlite.org/wal.html');

  // Caso SEARCH_PROVIDER=searxng, consulta a API JSON do SearXNG (/search?q=...&format=json) via undici
  let capturedSearxUrl = '';
  const searxRes = await searchBrave('sqlite wal searxng', {
    provider: 'searxng',
    searxngUrl: 'http://127.0.0.1:8888',
    disableKeylessFallback: true,
    requestFn: async (url) => {
      capturedSearxUrl = url;
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            results: [
              { url: 'https://docs.searxng.org/', title: 'SearXNG Docs', content: 'Metasearch engine' },
              { url: 'https://sqlite.org/wal.html', title: 'SQLite WAL', content: 'Write-Ahead Logging' }
            ]
          })
        }
      };
    }
  });
  assert.equal(searxRes.provider, 'searxng');
  assert.match(capturedSearxUrl, /http:\/\/127\.0\.0\.1:8888\/search\?q=sqlite\+wal\+searxng&format=json/);
  assert.equal(searxRes.results.length, 2);
  assert.equal(searxRes.results[0].url, 'https://docs.searxng.org/');
});

test('2. Extração @mozilla/readability + jsdom ignora páginas com falha e numera apenas as obtidas com sucesso', async () => {
  const candidates = [
    { url: 'https://fonte1.dev/ok', title: 'Fonte 1 OK' },
    { url: 'https://fonte2.dev/erro500', title: 'Fonte 2 Falha HTTP 500' },
    { url: 'https://fonte3.dev/ok', title: 'Fonte 3 OK' },
    { url: 'https://fonte4.dev/timeout', title: 'Fonte 4 Timeout' },
    { url: 'https://fonte5.dev/vazia', title: 'Fonte 5 Sem Texto' },
    { url: 'https://fonte6.dev/ok', title: 'Fonte 6 OK' }
  ];

  const mockRequestFn = async (url) => {
    if (url.includes('erro500')) {
      return { statusCode: 500, headers: {}, body: { dump: async () => {} } };
    }
    if (url.includes('timeout')) {
      throw new Error('ConnectTimeoutError');
    }
    if (url.includes('vazia')) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: Readable.from(['<html><body><nav>Menu</nav></body></html>'])
      };
    }

    const html = makeRichArticleHtml(
      `Título Verificado para ${url}`,
      `Este é um artigo técnico completo extraído com sucesso de ${url} contendo detalhes verificáveis sobre sistemas distribuídos, latência e armazenamento local em SQLite.`
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Readable.from([Buffer.from(html, 'utf-8')])
    };
  };

  const extraction = await extractTopSources(candidates, { requestFn: mockRequestFn });

  assert.equal(extraction.attemptedCount, 6);
  assert.equal(extraction.succeededCount, 3);
  assert.equal(extraction.sources.length, 3);

  // As páginas com falha JAMAIS entram na lista e as válidas são renumeradas [1], [2], [3]
  assert.deepEqual(
    extraction.sources.map((s) => s.citationIndex),
    [1, 2, 3]
  );
  assert.deepEqual(
    extraction.sources.map((s) => s.url),
    ['https://fonte1.dev/ok', 'https://fonte3.dev/ok', 'https://fonte6.dev/ok']
  );
});

test('3. Citações [1][2] viram links de rodapé e páginas não obtidas nunca são citadas', () => {
  const sources = [
    {
      citationIndex: 1,
      url: 'https://sqlite.org/wal.html',
      title: 'Write-Ahead Logging in SQLite',
      domain: 'sqlite.org',
      excerpt: 'WAL provides more concurrency as readers do not block writers.',
      wordCount: 11
    },
    {
      citationIndex: 2,
      url: 'https://htmx.org/docs/',
      title: 'htmx Documentation',
      domain: 'htmx.org',
      excerpt: 'htmx gives you access to AJAX, CSS Transitions, WebSockets and Server Sent Events directly in HTML.',
      wordCount: 16
    }
  ];

  // Se o LLM tentar citar [9] (inexistente) ou [1, 2], sanitizeCitations limpa [9] e normaliza [1][2]
  const rawMd = [
    'O modo **WAL** permite leituras concorrentes com escritas [1][2] e evita bloqueios [9].',
    '## Cronologia e Comparativo',
    '- **8:46 a. m.**: Evento inicial verificado [1]',
    '',
    '| Modo | Concorrência | Fonte |',
    '| --- | --- | --- |',
    '| WAL | Alta [1] | SQLite [2] |'
  ].join('\n');
  const html = renderAnswerMarkdownWithFootnotes(rawMd, 77, sources);

  assert.match(html, /class="top-sources-strip"/);
  assert.match(html, /class="top-source-card /);
  assert.match(html, /href="#source-77-1"/);
  assert.match(html, /href="#source-77-2"/);
  assert.match(html, /class="citation-host">sqlite\.org<\/span>/);
  assert.match(html, /<h4 class="answer-heading">Cronologia e Comparativo<\/h4>/);
  assert.match(html, /<table class="answer-table">/);
  assert.doesNotMatch(html, /\[9\]/);
  assert.doesNotMatch(html, /source-77-9/);

  const footnotesHtml = renderTurnSourcesFootnotes(77, sources, {
    status: 'completed',
    question: '11 de septiembre 2001'
  });
  assert.match(footnotesHtml, /id="source-77-1"/);
  assert.match(footnotesHtml, /id="source-77-2"/);
  assert.match(footnotesHtml, /data-copy-turn="77"/);
  assert.match(footnotesHtml, /class="followup-chip"/);
  assert.match(footnotesHtml, /11 de septiembre 2001/);
  assert.match(footnotesHtml, /https:\/\/sqlite\.org\/wal\.html/);
  assert.match(footnotesHtml, /https:\/\/htmx\.org\/docs\//);
});

test('4. Fluxo completo E2E (Express + htmx + SSE Streaming + SQLite + Follow-up mantendo contexto)', async () => {
  const db = createDatabase(':memory:');
  const capturedLlmCalls = [];

  const mockSearchFn = async (query) => ({
    results: [
      { url: 'https://doc1.local/sqlite', title: `Doc 1 sobre ${query}` },
      { url: 'https://doc2.local/falha', title: 'Doc 2 Falha' },
      { url: 'https://doc3.local/wal', title: `Doc 3 sobre ${query}` }
    ],
    error: null
  });

  const mockExtractFn = async (results) => {
    // Simula que doc2.local/falha falhou e foi ignorada
    const valid = results
      .filter((r) => !r.url.includes('falha'))
      .map((r, idx) => ({
        citationIndex: idx + 1,
        url: r.url,
        title: r.title,
        domain: new URL(r.url).hostname,
        siteName: 'Docs Local',
        excerpt: `Conteúdo extraído legível para ${r.title}.`,
        wordCount: 6,
        charCount: 45
      }));

    return {
      sources: valid,
      attemptedCount: results.length,
      succeededCount: valid.length,
      skippedUrls: ['https://doc2.local/falha']
    };
  };

  const indexedQdrantTurns = [];
  const mockQdrant = {
    checkHealth: async () => ({ online: true, collection: 'deepevil_conversations', pointsCount: indexedQdrantTurns.length }),
    indexTurn: async (payload) => {
      indexedQdrantTurns.push(payload);
      return { indexed: true, count: 1 + (payload.sources?.length || 0) };
    },
    deleteConversationPoints: async () => true,
    searchKnowledge: async () => []
  };

  const mockListModelsFn = async () => [
    { name: 'granite4.2:latest', parameterSize: '3.8B' },
    { name: 'gemma4:31b', parameterSize: '31B' },
    { name: 'qwen2.5-coder:14b', parameterSize: '14B' }
  ];

  const mockStreamAnswerFn = async ({ question, sources, priorTurns, selectedModel, onDelta }) => {
    capturedLlmCalls.push({
      question,
      selectedModel,
      sourcesCount: sources.length,
      priorTurnsCount: priorTurns.length,
      priorTurns
    });
    const chunks = [
      'De acordo com os trechos extraídos, ',
      'o mecanismo funciona com alta eficiência [1]',
      '[2].'
    ];
    let acc = '';
    for (const c of chunks) {
      acc += c;
      if (onDelta) onDelta(c, acc);
    }
    return {
      text: acc,
      provider: 'ollama',
      model: selectedModel || 'granite4.2:latest'
    };
  };

  const app = createApp({
    db,
    qdrant: mockQdrant,
    listModelsFn: mockListModelsFn,
    searchFn: mockSearchFn,
    extractFn: mockExtractFn,
    streamAnswerFn: mockStreamAnswerFn,
    env: {
      BRAVE_SEARCH_API_KEY: 'test_brave_key',
      LLM_PROVIDER: 'ollama',
      OLLAMA_MODEL: 'granite4.2:latest'
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 4.0 Verifica a identidade visual limpa DeepEvil (sem subtítulo poluído, com seletor Ollama e Qdrant Vector DB)
    const homeRes = await fetch(`${baseUrl}/`);
    assert.equal(homeRes.status, 200);
    const homeHtml = await homeRes.text();
    assert.match(homeHtml, /aria-label="DeepEvil"/);
    assert.match(homeHtml, /<span class="g-blue">D<\/span><span class="g-red">e<\/span><span class="g-yellow">e<\/span><span class="g-blue">p<\/span><span class="g-green">E<\/span><span class="g-red">v<\/span><span class="g-yellow">i<\/span><span class="g-blue">l<\/span>/);
    assert.doesNotMatch(homeHtml, /A estética clássica do Google fundida/, 'O texto descritivo antigo deve ter sido removido');
    assert.match(homeHtml, /id="model-select"/);
    assert.match(homeHtml, /gemma4:31b/);
    assert.doesNotMatch(homeHtml, /Qdrant Vector DB/);
    assert.doesNotMatch(homeHtml, /Qdrant \+ SQLite/);
    assert.doesNotMatch(homeHtml, /qdrant\.vector \+ sqlite\.wal/);

    // 4.0b Verifica o endpoint /api/models que lista os modelos do Ollama
    const modelsRes = await fetch(`${baseUrl}/api/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.equal(modelsJson.models.length, 3);
    assert.equal(modelsJson.models[1].name, 'gemma4:31b');

    // 4.1 Faz a primeira pergunta via POST /ask selecionando especificamente o modelo gemma4:31b
    const firstQuestion = 'Como funciona o isolamento no SQLite WAL?';
    const askRes1 = await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'HX-Request': 'true'
      },
      body: new URLSearchParams({
        question: firstQuestion,
        conversationId: '',
        model: 'gemma4:31b'
      })
    });

    assert.equal(askRes1.status, 200);
    const askHtml1 = await askRes1.text();
    assert.match(askHtml1, /sse-connect="\/stream\/1"/);
    assert.match(askHtml1, /Como funciona o isolamento no SQLite WAL\?/);

    // 4.2 Consome o stream SSE do turno 1 (/stream/1)
    const sseRes1 = await fetch(`${baseUrl}/stream/1`);
    assert.equal(sseRes1.status, 200);
    const sseText1 = await sseRes1.text();

    assert.match(sseText1, /event: status/);
    assert.match(sseText1, /event: sources/);
    assert.match(sseText1, /event: answer/);
    assert.match(sseText1, /href="#source-1-1"/);
    assert.match(sseText1, /href="#source-1-2"/);
    assert.doesNotMatch(sseText1, /doc2\.local\/falha/, 'Página que falhou jamais pode aparecer nas fontes ou citações');
    assert.match(sseText1, /event: done/);

    // Verifica que o modelo escolhido no seletor foi utilizado e que o turno foi indexado no Qdrant Vector DB
    assert.equal(capturedLlmCalls[0].selectedModel, 'gemma4:31b');
    assert.equal(indexedQdrantTurns.length, 1);
    assert.equal(indexedQdrantTurns[0].turn.model, 'gemma4:31b');

    // 4.3 Faz uma pergunta de acompanhamento (follow-up) na mesma conversa (conversationId=1) trocando para qwen2.5-coder:14b
    const followUpQuestion = 'E qual o impacto disso em discos NVMe?';
    const askRes2 = await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'HX-Request': 'true'
      },
      body: new URLSearchParams({
        question: followUpQuestion,
        conversationId: '1',
        model: 'qwen2.5-coder:14b'
      })
    });

    assert.equal(askRes2.status, 200);
    const sseRes2 = await fetch(`${baseUrl}/stream/2`);
    await sseRes2.text();

    // Verifica que a 2ª chamada ao LLM recebeu o contexto da 1ª pergunta e resposta + novo modelo selecionado
    assert.equal(capturedLlmCalls.length, 2);
    assert.equal(capturedLlmCalls[0].priorTurnsCount, 0);
    assert.equal(capturedLlmCalls[1].priorTurnsCount, 1);
    assert.equal(capturedLlmCalls[1].selectedModel, 'qwen2.5-coder:14b');
    assert.equal(capturedLlmCalls[1].priorTurns[0].question, firstQuestion);
    assert.equal(indexedQdrantTurns.length, 2);

    // Verifica que na barra lateral a conversa permanece identificada pela 1ª pergunta feita
    const conversations = db.listConversations();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].title, firstQuestion);
    assert.equal(Number(conversations[0].turn_count), 2);
  } finally {
    server.close();
    db.close();
  }
});

test('5. Streaming real de SSE para Anthropic Claude e OpenAI GPT via undici + Sanitização de citações', async () => {
  const sources = [
    {
      citationIndex: 1,
      url: 'https://developer.mozilla.org/pt-BR/docs/Web/API/Server-sent_events',
      title: 'Server-Sent Events - MDN',
      domain: 'developer.mozilla.org',
      excerpt: 'Server-sent events permitem que um servidor envie dados em tempo real via HTTP.',
      wordCount: 12
    }
  ];

  // 5.1 Testa parser SSE da Anthropic
  const anthropicSseFrames = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"O protocolo SSE opera sobre HTTP [1]"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" sem citar páginas inválidas [4]."}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];

  const deltasAnthropic = [];
  const resAnthropic = await streamAnswer({
    question: 'O que é SSE?',
    sources,
    priorTurns: [],
    env: {
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test'
    },
    requestFn: async () => ({
      statusCode: 200,
      body: Readable.from(anthropicSseFrames)
    }),
    onDelta: (_d, sanitized) => deltasAnthropic.push(sanitized)
  });

  assert.equal(resAnthropic.provider, 'anthropic');
  assert.equal(resAnthropic.text, 'O protocolo SSE opera sobre HTTP [1] sem citar páginas inválidas .');
  assert.ok(deltasAnthropic.length >= 2);

  // 5.2 Testa parser SSE da OpenAI
  const openaiSseFrames = [
    'data: {"choices":[{"delta":{"content":"Com GPT o streaming também cita [1]"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" e remove [99]."}}]}\n\n',
    'data: [DONE]\n\n'
  ];

  const resOpenAI = await streamAnswer({
    question: 'Como funciona no GPT?',
    sources,
    priorTurns: [],
    env: {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-proj-test'
    },
    requestFn: async () => ({
      statusCode: 200,
      body: Readable.from(openaiSseFrames)
    })
  });

  assert.equal(resOpenAI.provider, 'openai');
  assert.equal(resOpenAI.text, 'Com GPT o streaming também cita [1] e remove .');

  // 5.3 Testa parser NDJSON do Ollama (/api/chat com num_ctx=16384)
  let capturedOllamaBody = null;
  const ollamaNdjsonFrames = [
    '{"model":"granite4.2:latest","message":{"role":"assistant","content":"Rodando localmente via Ollama [1]"},"done":false}\n',
    '{"model":"granite4.2:latest","message":{"role":"assistant","content":" sem custo de API [88]."},"done":true}\n'
  ];

  const resOllama = await streamAnswer({
    question: 'Funciona com Ollama?',
    sources,
    priorTurns: [],
    env: {
      LLM_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      OLLAMA_MODEL: 'granite4.2:latest',
      OLLAMA_NUM_CTX: '16384'
    },
    requestFn: async (_url, opts) => {
      capturedOllamaBody = JSON.parse(opts.body);
      return {
        statusCode: 200,
        body: Readable.from(ollamaNdjsonFrames)
      };
    }
  });

  assert.equal(resOllama.provider, 'ollama');
  assert.equal(resOllama.model, 'granite4.2:latest');
  assert.equal(capturedOllamaBody.options.num_ctx, 16384);
  assert.equal(resOllama.text, 'Rodando localmente via Ollama [1] sem custo de API .');
});

test('6. Botão de Tradução com IA (/turns/:turnId/translate) traduz o Markdown preservando citações [1][2] e estrutura', async () => {
  const db = createDatabase(':memory:');
  const conv = db.createConversation('How do Linux kernel rootkits hook syscalls?');
  const turn = db.createTurn({
    conversationId: conv.id,
    question: conv.title,
    searchQuery: conv.title,
    provider: 'ollama',
    model: 'granite4.2-uncensored:latest'
  });

  const sources = [
    {
      citationIndex: 1,
      url: 'https://xcellerator.github.io/posts/linux_rootkits_02/',
      title: 'Linux Rootkits Part 2: Ftrace',
      domain: 'xcellerator.github.io',
      siteName: 'TheXcellerator',
      excerpt: 'Ftrace allows hooking kernel functions without overwriting sys_call_table.',
      wordCount: 10,
      charCount: 74
    },
    {
      citationIndex: 2,
      url: 'https://www.kernel.org/doc/html/latest/trace/ftrace-uses.html',
      title: 'Using ftrace to hook to functions',
      domain: 'kernel.org',
      siteName: 'Kernel Docs',
      excerpt: 'Ftrace records enabled functions in /sys/kernel/tracing/enabled_functions.',
      wordCount: 8,
      charCount: 74
    }
  ];

  db.saveTurnSources(turn.id, sources);
  db.completeTurn(turn.id, {
    answerMarkdown: 'Linux rootkits use **ftrace** to hook syscalls [1] and can be detected via tracing files [2].',
    provider: 'ollama',
    model: 'granite4.2-uncensored:latest',
    attemptedUrlsCount: 2,
    extractedSourcesCount: 2,
    durationMs: 1200
  });

  // Verifica que o botão data-translate-turn e o seletor de idioma estão presentes no HTML do rodapé
  const footnotesHtml = renderTurnSourcesFootnotes(turn.id, sources, {
    status: 'completed',
    question: conv.title
  });
  assert.match(footnotesHtml, /data-translate-turn="1"/);
  assert.match(footnotesHtml, /id="translate-lang-1"/);
  assert.match(footnotesHtml, /Traduzir/);
  assert.doesNotMatch(footnotesHtml, /Traduzir com IA/);
  assert.doesNotMatch(footnotesHtml, /Qdrant Vector Synced/);

  let llmTranslateCalls = 0;
  const app = createApp({
    db,
    qdrant: {
      checkHealth: async () => ({ online: true }),
      indexTurn: async () => ({ indexed: true }),
      deleteConversationPoints: async () => true,
      searchKnowledge: async () => []
    },
    translateTurnFn: async ({ targetLang, selectedModel, onDelta }) => {
      llmTranslateCalls += 1;
      const full = 'Rootkits de kernel Linux utilizam **ftrace** para interceptar syscalls [1] e podem ser detectados via arquivos de tracing [2].';
      if (typeof onDelta === 'function') {
        onDelta('Rootkits ', 'Rootkits ');
        onDelta('de kernel', full);
      }
      return {
        text: full,
        targetLang,
        languageLabel: 'Português do Brasil (pt-BR)',
        provider: 'ollama',
        model: selectedModel || 'granite4.2-uncensored:latest'
      };
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // 6.1 Primeira tradução via POST: invoca a LLM e salva no cache SQLite
    const res = await fetch(`http://127.0.0.1:${port}/turns/${turn.id}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLang: 'pt-BR', model: 'granite4.2-uncensored:latest' })
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.cached, false);
    assert.equal(llmTranslateCalls, 1);
    assert.equal(json.targetLang, 'pt-BR');
    assert.match(json.html, /class="translated-banner"/);
    assert.match(json.html, /Português do Brasil \(pt-BR\)/);
    assert.match(json.html, /Rootkits de kernel Linux utilizam <strong>ftrace<\/strong>/);
    assert.match(json.html, /href="#source-1-1"/);
    assert.match(json.html, /href="#source-1-2"/);

    // 6.2 Segunda tradução para o mesmo idioma: retorna instantaneamente do cache SQLite (0ms) sem chamar a LLM
    const cachedRes = await fetch(`http://127.0.0.1:${port}/turns/${turn.id}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLang: 'pt-BR', model: 'granite4.2-uncensored:latest' })
    });
    const cachedJson = await cachedRes.json();
    assert.equal(cachedJson.ok, true);
    assert.equal(cachedJson.cached, true);
    assert.equal(llmTranslateCalls, 1);
    assert.match(cachedJson.html, /\[cache 0ms\]/);

    // 6.3 Streaming SSE em tempo real (/turns/:turnId/translate/stream) para um novo idioma (es)
    const streamRes = await fetch(`http://127.0.0.1:${port}/turns/${turn.id}/translate/stream?lang=es`);
    assert.equal(streamRes.status, 200);
    const sseBody = await streamRes.text();
    assert.match(sseBody, /event: answer/);
    assert.match(sseBody, /event: done/);
    assert.equal(llmTranslateCalls, 2);

    // 6.4 Exportação de relatório Markdown (.md)
    const exportRes = await fetch(`http://127.0.0.1:${port}/turns/${turn.id}/export.md?lang=pt-BR`);
    assert.equal(exportRes.status, 200);
    const mdText = await exportRes.text();
    assert.match(mdText, /# How do Linux kernel rootkits hook syscalls\?/);
    assert.match(mdText, /Rootkits de kernel Linux utilizam \*\*ftrace\*\*/);
    assert.match(mdText, /Fontes Verificadas \(SERP \/\/ Readability\)/);
  } finally {
    server.close();
    db.close();
  }
});

test('7. Otimização #1: Early-Cutoff na extração corta alvos lentos após 4 sucessos e SERP Snippet Fallback salva resumos ricos', async () => {
  const candidates = [
    { url: 'https://fast1.dev/a', title: 'Fast 1' },
    { url: 'https://fast2.dev/b', title: 'Fast 2' },
    { url: 'https://fast3.dev/c', title: 'Fast 3' },
    { url: 'https://fast4.dev/d', title: 'Fast 4' },
    {
      url: 'https://cloudflare-blocked.dev/e',
      title: 'Cloudflare Blocked',
      description: 'Este é um resumo rico retornado diretamente pela SERP com mais de noventa caracteres explicando detalhadamente a arquitetura de proteção e mitigação DDoS.'
    },
    { url: 'https://hanging-host.dev/f', title: 'Hanging Host 5s' }
  ];

  const mockRequestFn = async (url, opts) => {
    if (url.includes('cloudflare-blocked')) {
      return { statusCode: 403, headers: {}, body: { dump: async () => {} } };
    }
    if (url.includes('hanging-host')) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 4000);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Aborted by Early-Cutoff'));
          });
        }
      });
    }
    const html = makeRichArticleHtml(
      `Artigo Rápido ${url}`,
      `Conteúdo técnico denso extraído em poucos milissegundos de ${url} com mais de oitenta caracteres verificados para leitura imediata.`
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Readable.from([Buffer.from(html, 'utf-8')])
    };
  };

  const t0 = Date.now();
  const outcome = await extractTopSources(candidates, {
    requestFn: mockRequestFn,
    earlyCutoffCount: 4,
    gracePeriodMs: 60
  });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 800, `Early-Cutoff deve abortar o host lento em ~60ms em vez de esperar 4000ms (levou ${elapsed}ms)`);
  // 4 páginas rápidas + 1 página bloqueada mas recuperada via SERP Snippet Fallback = 5 fontes
  assert.equal(outcome.succeededCount, 5);
  const snippetSource = outcome.sources.find((s) => s.domain === 'cloudflare-blocked.dev');
  assert.ok(snippetSource, 'Deve recuperar a fonte bloqueada pelo Cloudflare usando o snippet rico da SERP');
  assert.equal(snippetSource.isSerpSnippet, true);
});

test('8. Otimização #2: Focus Modes (web, secops, code, academic, hybrid) enriquecem queries e fundem conhecimento do Qdrant', async () => {
  assert.ok(FOCUS_MODES.secops);
  assert.ok(FOCUS_MODES.code);
  assert.ok(FOCUS_MODES.academic);
  assert.ok(FOCUS_MODES.hybrid);

  const secopsQuery = applyFocusModeToQuery('ftrace linux kernel', 'secops');
  assert.match(secopsQuery, /CVE exploit advisory vulnerability/);

  const codeQuery = buildContextualSearchQuery('redis cluster', [], 'code');
  assert.match(codeQuery, /architecture implementation source code/);

  // Verifica que o modo hybrid combina resultados do Qdrant com resultados Web no /stream/:turnId
  const db = createDatabase(':memory:');
  const app = createApp({
    db,
    qdrant: {
      checkHealth: async () => ({ online: true }),
      indexTurn: async () => true,
      deleteConversationPoints: async () => true,
      searchKnowledge: async () => [],
      searchHybridSources: async () => [
        {
          url: 'http://127.0.0.1:6333/dashboard#/collections/pe-agents-ibm-context',
          title: '[Base Homelab] Arquitetura OPNsense & Proxmox',
          domain: 'homelab.local.kb',
          siteName: 'Homelab Knowledge Base',
          excerpt: 'Documentação local verificada no Qdrant sobre a topologia de rede do Homelab.',
          wordCount: 12,
          charCount: 79
        }
      ]
    },
    searchFn: async () => ({
      results: [{ url: 'https://opnsense.org/docs', title: 'OPNsense Official Docs' }],
      error: null
    }),
    extractFn: async (results) => ({
      sources: results.map((r, i) => ({
        citationIndex: i + 1,
        url: r.url,
        title: r.title,
        domain: 'opnsense.org',
        siteName: 'OPNsense',
        excerpt: 'Official documentation for OPNsense firewall configuration.',
        wordCount: 7,
        charCount: 59
      })),
      attemptedCount: 1,
      succeededCount: 1
    }),
    streamAnswerFn: async ({ sources, onDelta }) => {
      const txt = `Combinando a fonte web [1] com a memória local do Homelab [2].`;
      if (onDelta) onDelta(txt, txt);
      return { text: txt, provider: 'ollama', model: 'granite4.2-uncensored:latest' };
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const askRes = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true' },
      body: new URLSearchParams({
        question: 'Como está configurado o firewall?',
        conversationId: '',
        model: 'granite4.2-uncensored:latest',
        focusMode: 'hybrid'
      })
    });
    assert.equal(askRes.status, 200);

    const sseRes = await fetch(`http://127.0.0.1:${port}/stream/1`);
    const sseText = await sseRes.text();
    assert.match(sseText, /opnsense\.org/);
    assert.match(sseText, /homelab\.local\.kb/);
    assert.match(sseText, /href="#source-1-2"/);
  } finally {
    server.close();
    db.close();
  }
});

test('9. Otimização #3: Embeddings semânticos reais bge-m3 via Ollama (/api/embed) com projeção L2 1024d -> 384d', async () => {
  const fake1024 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1));
  const emb = await embedTextSemantic('arquitetura de busca vetorial', {
    env: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_EMBED_MODEL: 'bge-m3:latest' },
    httpRequest: async (url) => {
      assert.match(url, /\/api\/embed$/);
      return {
        statusCode: 200,
        body: {
          json: async () => ({ embeddings: [fake1024] })
        }
      };
    }
  });

  assert.equal(emb.semantic, true);
  assert.equal(emb.model, 'bge-m3:latest');
  assert.equal(emb.rawVector.length, 1024);
  assert.equal(emb.vector384.length, 384);

  const norm = Math.sqrt(emb.vector384.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(norm - 1.0) < 0.01, `Vetor projetado deve estar L2-normalizado (norma=${norm})`);
});

test('10. Otimização #4: Follow-ups dinâmicos extraem cabeçalhos Markdown, entidades em negrito e títulos reais das fontes', () => {
  const sources = [
    { title: 'eBPF XDP High-Performance Packet Processing — Kernel Docs', domain: 'kernel.org', url: 'https://kernel.org/xdp' },
    { title: 'DPDK Poll Mode Driver Benchmarks — Intel', domain: 'intel.com', url: 'https://intel.com/dpdk' }
  ];
  const answerMd = [
    'O **XDP (eXpress Data Path)** processa pacotes diretamente no driver antes da alocação de `sk_buff` [1].',
    '## Comparativo de Latência em Kernel 6.x',
    'O **DPDK** opera em user-space via bypass de kernel [2].'
  ].join('\n');

  const concepts = extractKeyConceptsFromTurn(sources, answerMd, 'XDP vs DPDK');
  assert.ok(concepts.some((c) => /Comparativo de Latência/i.test(c)));
  assert.ok(concepts.some((c) => /XDP|sk_buff/i.test(c)));

  const followUps = buildContextualFollowUps('XDP vs DPDK', sources, answerMd);
  assert.equal(followUps.length, 4);
  assert.match(followUps[0], /Comparativo de Latência/i);
  assert.match(followUps[0], /XDP vs DPDK/);
});

test('11. Otimização #5: Botão Regerar (/turns/:turnId/rewrite) troca LLM reutilizando fontes (0 chamadas web) e Stop (/turns/:turnId/stop) interrompe stream', async () => {
  const db = createDatabase(':memory:');
  let webSearchCalls = 0;
  let webExtractCalls = 0;

  const app = createApp({
    db,
    qdrant: {
      checkHealth: async () => ({ online: true }),
      indexTurn: async () => true,
      deleteConversationPoints: async () => true,
      searchKnowledge: async () => []
    },
    searchFn: async () => {
      webSearchCalls += 1;
      return {
        results: [{ url: 'https://kernel.org/ftrace', title: 'Ftrace Kernel Docs' }],
        error: null
      };
    },
    extractFn: async (results) => {
      webExtractCalls += 1;
      return {
        sources: results.map((r, idx) => ({
          citationIndex: idx + 1,
          url: r.url,
          title: r.title,
          domain: 'kernel.org',
          siteName: 'Kernel',
          excerpt: 'Ftrace internal hooking mechanism in the Linux kernel.',
          wordCount: 8,
          charCount: 54
        })),
        attemptedCount: 1,
        succeededCount: 1
      };
    },
    streamAnswerFn: async ({ selectedModel, signal, onDelta }) => {
      if (selectedModel === 'slow-stoppable-model') {
        onDelta('Início parcial da resposta [1] ', 'Início parcial da resposta [1] ');
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 3000);
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          }
        });
        return {
          text: 'Início parcial da resposta [1]',
          provider: 'ollama',
          model: selectedModel,
          aborted: Boolean(signal && signal.aborted)
        };
      }
      const msg = `Síntese gerada pelo modelo ${selectedModel} [1].`;
      if (onDelta) onDelta(msg, msg);
      return { text: msg, provider: 'ollama', model: selectedModel, aborted: false };
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 11.1 Cria o turno 1 e executa o stream inicial
    await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true' },
      body: new URLSearchParams({ question: 'O que é ftrace?', model: 'granite4.2-uncensored:latest' })
    });
    const sse1 = await (await fetch(`${baseUrl}/stream/1`)).text();
    assert.match(sse1, /Síntese gerada pelo modelo granite4\.2-uncensored:latest/);
    assert.equal(webSearchCalls, 1);
    assert.equal(webExtractCalls, 1);

    // 11.2 Aciona /turns/1/rewrite trocando para qwen2.5-coder:14b -> 0 novas chamadas de busca/extração web!
    const rewriteRes = await fetch(`${baseUrl}/turns/1/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-coder:14b' })
    });
    const rewriteJson = await rewriteRes.json();
    assert.equal(rewriteJson.ok, true);
    assert.equal(rewriteJson.model, 'qwen2.5-coder:14b');
    assert.equal(rewriteJson.sourcesCount, 1);

    const sseRewrite = await (await fetch(`${baseUrl}/stream/1`)).text();
    assert.match(sseRewrite, /Síntese gerada pelo modelo qwen2\.5-coder:14b/);
    assert.equal(webSearchCalls, 1, 'Rewrite NÃO deve refazer a busca na web');
    assert.equal(webExtractCalls, 1, 'Rewrite NÃO deve refazer a extração DOM');

    // 11.3 Testa Stop Generation (/turns/1/stop) durante um stream lento
    await fetch(`${baseUrl}/turns/1/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'slow-stoppable-model' })
    });

    const streamPromise = fetch(`${baseUrl}/stream/1`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 60));

    const stopRes = await fetch(`${baseUrl}/turns/1/stop`, { method: 'POST' });
    const stopJson = await stopRes.json();
    assert.equal(stopJson.ok, true);
    assert.equal(stopJson.stopped, true);

    const stoppedSse = await streamPromise;
    assert.match(stoppedSse, /Geração interrompida pelo operador/);
  } finally {
    server.close();
    db.close();
  }
});

test('12. Otimização #6: Hover Preview Card (.citation-popover) nas citações inline e Frame Batching SSE (createFrameBatcher)', async () => {
  const sources = [
    {
      citationIndex: 1,
      url: 'https://sqlite.org/wal.html',
      title: 'Write-Ahead Logging in SQLite',
      domain: 'sqlite.org',
      excerpt: 'WAL provides concurrency because readers do not block writers.',
      wordCount: 9
    }
  ];

  const html = renderAnswerMarkdownWithFootnotes('O modo WAL é rápido [1].', 10, sources);
  assert.match(html, /class="citation-popover"/);
  assert.match(html, /class="citation-popover-domain">sqlite\.org<\/span>/);
  assert.match(html, /class="citation-popover-title">Write-Ahead Logging in SQLite<\/span>/);
  assert.match(html, /class="citation-popover-excerpt">WAL provides concurrency/);

  // Verifica que o badge de status em streaming possui o botão data-stop-turn
  const badgeHtml = renderPipelineStatusBadge('streaming', { turnId: 10, provider: 'ollama', extractedCount: 1 });
  assert.match(badgeHtml, /data-stop-turn="10"/);

  // Testa createFrameBatcher: 1º frame sai em 0ms, próximos 4 dentro da janela são agrupados em 1 único frame
  const emitted = [];
  const batcher = createFrameBatcher((val) => emitted.push(val), 50);
  batcher.push('t1');
  batcher.push('t2');
  batcher.push('t3');
  batcher.push('t4');
  assert.deepEqual(emitted, ['t1'], 'O primeiro token deve sair imediatamente (0ms TTFT) e os seguintes aguardam a janela');
  batcher.flush();
  assert.deepEqual(emitted, ['t1', 't4'], 'O flush final emite apenas o estado acumulado mais recente');
});

test('13. Global Research (Worldwide): remove limitação ao Brasil, converte termos PT->EN, filtra portais escolares rasos e prioriza fontes globais', async () => {
  // 13.1 Conversão PT -> Global Research sem trava regional
  assert.equal(isExplicitBrazilQuery('como funciona um reator nuclear de fissão'), false);
  assert.equal(isExplicitBrazilQuery('taxa selic banco central do brasil'), true);

  const globalReactor = toGlobalResearchQuery('como funciona um reator nuclear de fissão');
  assert.match(globalReactor, /nuclear fission reactor/i);
  assert.doesNotMatch(globalReactor, /\bcomo funciona\b/i);

  const globalNapalm = toGlobalResearchQuery('como fazer napalm');
  assert.match(globalNapalm, /synthesis composition napalm/i);

  // 13.2 Ranking de coerência e filtragem de fazendas de conteúdo escolar (.br) vs fontes globais
  const mixedCandidates = [
    {
      url: 'https://brasilescola.uol.com.br/fisica/energia-nuclear.htm',
      title: 'Energia nuclear - Brasil Escola',
      description: 'Resumo escolar básico sobre energia nuclear.'
    },
    {
      url: 'https://todamateria.com.br/fissao-nuclear/',
      title: 'Fissão Nuclear - Toda Matéria',
      description: 'Texto escolar para ensino médio.'
    },
    {
      url: 'https://en.wikipedia.org/wiki/Nuclear_reactor',
      title: 'Nuclear reactor — Wikipedia (EN)',
      description: 'A nuclear reactor is a device used to initiate and control a fission nuclear chain reaction.'
    },
    {
      url: 'https://arxiv.org/abs/2401.00001',
      title: 'Neutron transport in nuclear fission reactors — ArXiv',
      description: 'Detailed Monte Carlo analysis of nuclear fission reactor core physics.'
    }
  ];

  const ranked = normalizeTopResults(mixedCandidates, 6, 'como funciona um reator nuclear de fissão');
  assert.equal(ranked.length, 2, 'Portais escolares rasos (Brasil Escola / Toda Matéria) devem ser descartados quando há fontes globais');
  assert.equal(ranked[0].url, 'https://en.wikipedia.org/wiki/Nuclear_reactor');
  assert.equal(ranked[1].url, 'https://arxiv.org/abs/2401.00001');

  // 13.3 Verifica que searchKeylessWeb envia kl=wt-wt (Worldwide) no DuckDuckGo, ensearch=1 no Bing e consulta en.wikipedia.org primeiro
  const requestedUrls = [];
  const keylessRes = await searchKeylessWeb('arquitetura raft consenso distribuído', {
    httpRequest: async (url) => {
      requestedUrls.push(url);
      if (url.includes('duckduckgo.com')) {
        return { statusCode: 202, body: { dump: async () => {} } };
      }
      if (url.includes('bing.com')) {
        return {
          statusCode: 200,
          body: { text: async () => '<html><body></body></html>' }
        };
      }
      if (url.includes('en.wikipedia.org')) {
        return {
          statusCode: 200,
          body: {
            json: async () => ({
              query: {
                search: [
                  {
                    title: 'Raft (algorithm)',
                    snippet: 'Raft is a distributed consensus algorithm designed as an alternative to Paxos.'
                  }
                ]
              }
            })
          }
        };
      }
      return { statusCode: 404, body: { text: async () => '' } };
    }
  });

  assert.ok(requestedUrls.some((u) => u.includes('duckduckgo.com') && u.includes('kl=wt-wt')));
  assert.ok(requestedUrls.some((u) => u.includes('bing.com') && u.includes('ensearch=1') && u.includes('setmkt=en-US')));
  assert.ok(requestedUrls.some((u) => u.includes('en.wikipedia.org')));
  assert.equal(keylessRes.results[0].url, 'https://en.wikipedia.org/wiki/Raft_(algorithm)');

  // 13.4 Reconstrução de abstract científico do OpenAlex
  const abstract = reconstructOpenAlexAbstract({
    Raft: [0],
    achieves: [1],
    consensus: [2],
    via: [3],
    leader: [4],
    election: [5]
  });
  assert.equal(abstract, 'Raft achieves consensus via leader election');
});

test('14. Granite 4.2 32K Context & Anti-Context-Bleeding: num_ctx padrão 32768 e isolamento de citações entre turnos', () => {
  const defaultCfg = resolveLlmConfig({});
  assert.equal(defaultCfg.provider, 'ollama');
  assert.equal(defaultCfg.model, 'granite4.2-uncensored:latest');
  assert.equal(defaultCfg.numCtx, 32768, 'O contexto padrão do Granite 4.2 deve ser 32768 tokens');

  const priorTurns = [
    {
      question: 'Como funciona o Kademlia DHT?',
      answer_markdown: 'Cada nó mantém k-buckets com k=20 e α-Limiter [1][2].'
    }
  ];
  const currentSources = [
    {
      citationIndex: 1,
      title: 'Iroh QUIC P2P',
      url: 'https://github.com/n0-computer/iroh',
      domain: 'github.com',
      excerpt: 'Iroh establishes direct QUIC connections using NodeId public keys.'
    }
  ];

  const messages = buildConversationMessages(priorTurns, 'Como funciona o Iroh sobre QUIC?', currentSources);
  assert.equal(messages.length, 1, 'Deve enviar uma mensagem limpa sem poluir com turns assistant antigos');
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content, /Pergunta anterior 1: "Como funciona o Kademlia DHT\?"/);
  assert.doesNotMatch(messages[0].content, /α-Limiter \[1\]\[2\]/, 'Não deve vazar respostas antigas nem citações [1][2] do turno anterior');

  const cleaned = sanitizeCitations('Controle de Concórvora e Motorres *[1][2]*', 2);
  assert.equal(cleaned, 'Controle de Concorrência e Motores [1][2]');
});

test('15. Federação Geopolítica Multi-Polo (🇺🇸 US + 🇨🇳 China + 🇷🇺 Rússia + 🇧🇷 Brasil/Português) e Precisão de Entidades', () => {
  const q = 'qual o modelo de IA mais forte para desenvolvimento atualmente';
  const globalQ = toGlobalResearchQuery(q);
  assert.match(globalQ, /AI model LLM/i);
  assert.match(globalQ, /software development coding programming/i);
  assert.doesNotMatch(globalQ, /\b(qual|modelo|desenvolvimento|atualmente)\b/i);

  const poles = buildMultiPolarQueries(q);
  assert.match(poles.us, /SWE-bench/i);
  assert.match(poles.cn, /大模型.*DeepSeek.*Qwen/i);
  assert.match(poles.ru, /большие языковые модели.*программирование/i);
  assert.match(poles.br, /modelos de inteligência artificial/i);

  // Testa tradução de ontologia + Palantir sem contaminar com termos genéricos de programação
  const palantirQ = 'me traga materiais de ontologia de IA pela palantir';
  const palantirGlobal = toGlobalResearchQuery(palantirQ);
  assert.match(palantirGlobal, /Palantir Foundry AIP Ontology/i);
  assert.doesNotMatch(palantirGlobal, /\bmateriais\b/i);
  const palantirPoles = buildMultiPolarQueries(palantirQ);
  assert.match(palantirPoles.us, /Palantir Foundry AIP Ontology/i);
  assert.match(palantirPoles.cn, /Palantir.*Foundry.*本体.*知识图谱/i);
  assert.match(palantirPoles.ru, /Palantir.*Foundry.*онтология данных/i);
  assert.match(palantirPoles.br, /Palantir Foundry AIP ontologia de dados/i);

  assert.equal(
    isPortugueseOrBrazilianBubbleResult({
      url: 'https://botpress.com/pt/blog/best-large-language-models',
      title: 'Os 10 melhores grandes modelos de linguagem'
    }, q),
    true
  );
  assert.equal(
    isPortugueseOrBrazilianBubbleResult({
      url: 'https://habr.com/ru/articles/1021388/',
      title: 'Какую LLM ставить в production'
    }, q),
    false
  );

  const selected = selectMultiPolarTopResults({
    usPool: [
      { url: 'https://botpress.com/pt/blog/best-large-language-models', title: 'Bolha PT no pool US' },
      { url: 'https://arxiv.org/abs/2501.00001', title: 'SWE-bench Verified US' },
      { url: 'https://en.wikipedia.org/wiki/Large_language_model', title: 'LLM US' },
      { url: 'https://livebench.ai/leaderboard', title: 'LiveBench US' }
    ],
    cnPool: [
      { url: 'https://opencompass.org.cn/leaderboard-llm', title: 'OpenCompass CN' },
      { url: 'https://zh.wikipedia.org/wiki/DeepSeek-V3', title: 'DeepSeek-V3 CN' },
      { url: 'https://github.com/QwenLM/Qwen2.5-Coder', title: 'Qwen2.5-Coder CN' }
    ],
    ruPool: [
      { url: 'https://habr.com/ru/articles/1021388/', title: 'Habr LLM Benchmark RU' },
      { url: 'https://mera.a-ai.ru/ru/leaderboard', title: 'MERA Benchmark RU' },
      { url: 'https://ru.wikipedia.org/wiki/Большая_языковая_модель', title: 'LLM Wiki RU' }
    ],
    brPool: [
      { url: 'https://brasilescola.uol.com.br/informatica/ia.htm', title: 'Site escolar raso bloqueado' },
      { url: 'https://pt.wikipedia.org/wiki/Grande_modelo_de_linguagem', title: 'Grande modelo de linguagem — Wikipedia (PT)' },
      { url: 'https://scielo.br/j/ea/a/ia-generativa-usp', title: 'Modelos de Linguagem e Engenharia de Software — USP' }
    ]
  }, 9, q);

  assert.equal(selected.length, 9);
  assert.ok(!selected.some((s) => s.url.includes('botpress.com/pt/')), 'Bolha /pt/ infiltrada no pool US deve ser bloqueada');
  assert.ok(!selected.some((s) => s.url.includes('brasilescola')), 'Domínio escolar raso no pool BR deve ser bloqueado');
  assert.match(selected[0].title, /^\[🇺🇸 US\]/);
  assert.match(selected[1].title, /^\[🇨🇳 CN\]/);
  assert.match(selected[2].title, /^\[🇷🇺 RU\]/);
  assert.match(selected[3].title, /^\[🇧🇷 BR\]/);

  // Escopo 'external' (🌐 Só Externo): 0% Brasil/PT mesmo se houver itens no brPool
  const externalOnly = selectMultiPolarTopResults({
    usPool: [
      { url: 'https://arxiv.org/abs/2501.00001', title: 'SWE-bench Verified US' },
      { url: 'https://en.wikipedia.org/wiki/Large_language_model', title: 'LLM US' },
      { url: 'https://livebench.ai/leaderboard', title: 'LiveBench US' }
    ],
    cnPool: [
      { url: 'https://opencompass.org.cn/leaderboard-llm', title: 'OpenCompass CN' },
      { url: 'https://zh.wikipedia.org/wiki/DeepSeek-V3', title: 'DeepSeek-V3 CN' },
      { url: 'https://github.com/QwenLM/Qwen2.5-Coder', title: 'Qwen2.5-Coder CN' }
    ],
    ruPool: [
      { url: 'https://habr.com/ru/articles/1021388/', title: 'Habr LLM Benchmark RU' },
      { url: 'https://mera.a-ai.ru/ru/leaderboard', title: 'MERA Benchmark RU' },
      { url: 'https://ru.wikipedia.org/wiki/Большая_языковая_модель', title: 'LLM Wiki RU' }
    ],
    brPool: [
      { url: 'https://pt.wikipedia.org/wiki/Grande_modelo_de_linguagem', title: 'Grande modelo de linguagem — Wikipedia (PT)' }
    ]
  }, 9, q, 'external');
  assert.equal(externalOnly.length, 9);
  assert.ok(externalOnly.every((s) => !s.title.startsWith('[🇧🇷 BR]')), 'No modo external nenhuma fonte BR deve entrar');

  // Escopo 'brazil' (🇧🇷 Só Brasil): 100% Brasil/PT de alta autoridade (bloqueando brasilescola)
  const brazilOnly = selectMultiPolarTopResults({
    usPool: [{ url: 'https://arxiv.org/abs/2501.00001', title: 'US Paper' }],
    brPool: [
      { url: 'https://brasilescola.uol.com.br/informatica/ia.htm', title: 'Site escolar raso bloqueado' },
      { url: 'https://pt.wikipedia.org/wiki/Grande_modelo_de_linguagem', title: 'Grande modelo de linguagem — Wikipedia (PT)' },
      { url: 'https://scielo.br/j/ea/a/ia-generativa-usp', title: 'Modelos de Linguagem e Engenharia de Software — USP' }
    ]
  }, 9, q, 'brazil');
  assert.equal(brazilOnly.length, 2);
  assert.ok(brazilOnly.every((s) => s.title.startsWith('[🇧🇷 BR]')), 'No modo brazil todas as fontes devem ser do polo BR');
  assert.ok(!brazilOnly.some((s) => s.url.includes('brasilescola')));
});

test('16. Expansão Global 7 Polos (US·CN·DE·JP·KR·RU·BR), Seletor de Idioma (searchLang) e Command Deck UI (/taste-design-direction)', async () => {
  const { renderComposerForm, renderTopSourcesStrip, renderTurnCard } = require('../src/render');

  const poles = buildMultiPolarQueries('me traga materiais de ontologia de IA pela palantir');
  assert.match(poles.de, /Ontologie Informatik/i);
  assert.match(poles.jp, /オントロジー/);
  assert.match(poles.kr, /온톨로지/);

  const sevenPolesSelected = selectMultiPolarTopResults({
    usPool: [{ url: 'https://arxiv.org/abs/2501.00001', title: 'Enterprise AI Ontology' }],
    cnPool: [{ url: 'https://zh.wikipedia.org/wiki/知识图谱', title: '知识图谱 — Wikipedia (ZH)' }],
    dePool: [{ url: 'https://de.wikipedia.org/wiki/Wissensgraph', title: 'Wissensgraph — Wikipedia (DE)' }],
    jpPool: [{ url: 'https://ja.wikipedia.org/wiki/ナレッジグラフ', title: 'ナレッジグラフ — Wikipedia (JA)' }],
    krPool: [{ url: 'https://ko.wikipedia.org/wiki/지식_그래프', title: '지식 그래프 — Wikipedia (KO)' }],
    ruPool: [{ url: 'https://habr.com/ru/articles/1021388/', title: 'Граф знаний — Habr Engineering' }],
    brPool: [{ url: 'https://pt.wikipedia.org/wiki/Grafo_de_conhecimento', title: 'Grafo de conhecimento — Wikipedia (PT)' }]
  }, 7, 'ontologia de IA', 'global');

  assert.equal(sevenPolesSelected.length, 7);
  assert.match(sevenPolesSelected[0].title, /^\[🇺🇸 US\]/);
  assert.match(sevenPolesSelected[1].title, /^\[🇨🇳 CN\]/);
  assert.match(sevenPolesSelected[2].title, /^\[🇩🇪 DE\]/);
  assert.match(sevenPolesSelected[3].title, /^\[🇯🇵 JP\]/);
  assert.match(sevenPolesSelected[4].title, /^\[🇰🇷 KR\]/);
  assert.match(sevenPolesSelected[5].title, /^\[🇷🇺 RU\]/);
  assert.match(sevenPolesSelected[6].title, /^\[🇧🇷 BR\]/);

  const composerHtml = renderComposerForm(null, false, {
    activeScope: 'global',
    activeLang: 'pt-BR',
    activeFocus: 'web'
  });
  assert.match(composerHtml, /composer-command-deck/);
  assert.match(composerHtml, /composer-control-deck/);
  assert.match(composerHtml, /id="scope-select"/);
  assert.match(composerHtml, /id="lang-select"/);
  assert.match(composerHtml, /name="searchLang"/);
  assert.match(composerHtml, /Global · 7 Polos \(US·CN·DE·JP·KR·RU·BR\)/);

  const stripHtml = renderTopSourcesStrip(42, [
    {
      citationIndex: 1,
      domain: 'de.wikipedia.org',
      title: '[🇩🇪 DE] Grafos de Conhecimento e Sistemas Semânticos — Wikipedia (DE)',
      originalTitle: '[🇩🇪 DE] Wissensgraphen und Semantische Systeme — Wikipedia (DE)'
    },
    {
      citationIndex: 2,
      domain: 'ja.wikipedia.org',
      title: '[🇯🇵 JP] Grafo de Conhecimento — Wikipedia (JA)',
      originalTitle: '[🇯🇵 JP] ナレッジグラフ — Wikipedia (JA)'
    }
  ]);
  assert.match(stripHtml, /top-source-pole-tag/);
  assert.match(stripHtml, /🇩🇪 DE/);
  assert.match(stripHtml, /🇯🇵 JP/);
  assert.match(stripHtml, /Grafos de Conhecimento e Sistemas Semânticos/);

  const turnCardHtml = renderTurnCard({
    id: 42,
    question: 'Como funcionam grafos de conhecimento?',
    search_query: 'knowledge graph',
    search_scope: 'global',
    search_lang: 'pt-BR',
    status: 'completed',
    answer_markdown: 'Resumo [1].',
    sources: []
  });
  assert.match(turnCardHtml, /turn-lang-badge/);
  assert.match(turnCardHtml, /Headlines &amp; Síntese: PT-BR/);
});








