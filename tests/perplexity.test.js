'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');

const { createDatabase } = require('../src/db');
const { searchBrave, buildContextualSearchQuery } = require('../src/search');
const { extractReadablePage, extractTopSources } = require('../src/extractor');
const {
  buildConversationMessages,
  sanitizeCitations,
  streamAnswer
} = require('../src/llm');
const {
  renderAnswerMarkdownWithFootnotes,
  renderTurnSourcesFootnotes
} = require('../src/render');
const { createApp } = require('../src/server');

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
    assert.match(homeHtml, /Qdrant Vector DB/);

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


