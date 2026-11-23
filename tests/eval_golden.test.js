'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  collectMultiPolarFederation
} = require('../src/search');
const {
  planSearchIntent,
  buildMultiPolarQueries,
  buildContextualSearchQuery
} = require('../src/search/planner');
const {
  canonicalizeUrl,
  normalizeEntitySlug,
  deduplicateResults
} = require('../src/search/dedup');
const { rerankCandidates, rerankCandidatesAsync } = require('../src/search/reranker');
const {
  TtlCache,
  protectEntities,
  restoreEntities
} = require('../src/search/translator');
const {
  selectQueryFocusedPassages,
  extractReadablePage,
  readBodyWithLimit
} = require('../src/extractor');
const {
  classifyResponseProfile,
  buildSystemPrompt,
  verifyCitationGrounding,
  estimateTokenCount,
  fitSourcesToTokenBudget,
  createIncrementalCitationSanitizer,
  listOllamaModels,
  clearOllamaModelsCache,
  translateTurnMarkdown
} = require('../src/llm');
const {
  DEFAULT_COLLECTION,
  DEFAULT_VECTOR_SIZE,
  DEFAULT_SCORE_THRESHOLD,
  embedTextSemantic,
  embedTextsBatch,
  createQdrantStore,
  cosineSimilarity
} = require('../src/qdrant');
const {
  renderFullPage,
  renderTurnCard,
  renderTopSourcesStrip,
  renderAnswerMarkdownWithFootnotes
} = require('../src/render');

function collectAllPoleStrings(mp) {
  return [
    mp.us,
    mp.usWiki,
    mp.cn,
    mp.cnWiki,
    mp.de,
    mp.deWiki,
    mp.jp,
    mp.jpWiki,
    mp.kr,
    mp.krWiki,
    mp.ru,
    mp.ruWiki,
    mp.br,
    mp.brWiki,
    mp.enCore,
    mp.academicCore,
    ...(mp.subQueries || [])
  ]
    .filter(Boolean)
    .join(' || ');
}

// ============================================================================
// 1. GOLDEN EVAL SET: 12+ Queries (Regressões Reais + Out-of-Distribution)
// ============================================================================
test('Eval-1: Regressão BackBox Linux data recovery -> howto_tech, shouldIncludeAcademic=false, 0x Microservices', () => {
  const q = 'qual o software que vem no backbox linux para recuperação de dados';
  const plan = planSearchIntent(q);
  const poles = buildMultiPolarQueries(q);

  assert.equal(plan.intent, 'howto_tech');
  assert.equal(plan.shouldIncludeAcademic, false);
  assert.equal(plan.domain, 'software_cs');
  assert.ok(plan.subQueries.some((sq) => /BackBox.*TestDisk|PhotoRec|Foremost/i.test(sq)));

  const allPolesText = collectAllPoleStrings(poles);
  assert.doesNotMatch(
    allPolesText,
    /microservices?|microsservi[çc]os?|微服务|マイクロサービス|마이크로서비스|микросервис/i,
    'Query sobre BackBox Linux JAMAIS pode sofrer sequestro para Microservices'
  );
});

test('Eval-2: Regressão concorrente chinês do Hugging Face -> 0x Hugging_Face forçado e inclui ModelScope', () => {
  const q = 'site de llm china concorrente do hugface';
  const plan = planSearchIntent(q);
  const poles = buildMultiPolarQueries(q);

  assert.equal(plan.shouldIncludeAcademic, false);
  assert.equal(poles.us, 'ModelScope');
  assert.match(poles.enCore, /ModelScope/i);
  assert.match(poles.cn, /魔搭社区/);
  assert.match(poles.cn, /ModelScope/);

  const allPolesText = collectAllPoleStrings(poles);
  assert.doesNotMatch(allPolesText, /Hugging_Face/, 'Nenhum polo pode forçar Wikipedia Hugging_Face');
  assert.doesNotMatch(allPolesText, /microservices?|microsservi/i);
});

test('Eval-3: Regressão "mapa de conflitos hoje guerra" -> breaking_news, freshness=day, reranker descarta guerras antigas e jogos', () => {
  const q = 'mapa de conflitos hoje guerra';
  const plan = planSearchIntent(q);

  assert.equal(plan.intent, 'breaking_news');
  assert.equal(plan.freshness, 'day');
  assert.equal(plan.shouldIncludeAcademic, false);
  assert.equal(plan.shouldUseNewsRss, true);
  assert.equal(plan.shouldUseMultiWiki, false);

  const noisyPool = [
    {
      url: 'https://liveuamap.com/',
      title: 'Live Universal Awareness Map — Live Conflict Map Today 2026',
      description: 'Interactive live map of current armed conflicts, wars and breaking security events updated today in 2026.',
      engine: 'searxng',
      engineRank: 1,
      publishedYear: 2026
    },
    {
      url: 'https://acleddata.com/conflict-index/',
      title: 'ACLED Live Conflict Index & Global War Tracker 2026',
      description: 'Real-time armed conflict data mapping active wars and geopolitical crises worldwide today.',
      engine: 'searxng',
      engineRank: 2,
      publishedYear: 2026
    },
    {
      url: 'https://www.reuters.com/world/global-conflicts-live-updates-2026/',
      title: 'Global conflicts and wars today — Reuters Live Updates',
      description: 'Latest breaking updates on active armed conflicts around the world today.',
      engine: 'gnews',
      engineRank: 1,
      isNewsHeadline: true,
      publishedYear: 2026
    },
    {
      url: 'https://en.wikipedia.org/wiki/Vietnam_War',
      title: 'Vietnam War — Wikipedia (EN)',
      description: 'The Vietnam War was an armed conflict in Vietnam, Laos, and Cambodia from 1955 to 1975.',
      engine: 'wikipedia',
      engineRank: 1,
      publishedYear: 1975
    },
    {
      url: 'https://ko.wikipedia.org/wiki/6.25_전쟁',
      title: '6.25 전쟁 (Korean War 1950) — Wikipedia (KO)',
      description: 'Korean War fought between North Korea and South Korea from 1950 to 1953.',
      engine: 'wikipedia',
      engineRank: 2,
      publishedYear: 1950
    },
    {
      url: 'https://openalex.org/W18940001',
      title: 'Sugar plantation trade treaties in the First Sino-Japanese War of 1894',
      description: 'Historical sugar export pricing during nineteenth-century naval campaigns of 1894.',
      engine: 'openalex',
      engineRank: 1,
      publishedYear: 1894
    },
    {
      url: 'https://pt.wikipedia.org/wiki/Traidor_(jogo)',
      title: 'Traidor (jogo) — Wikipedia (PT)',
      description: 'Traidor é um jogo eletrônico de tabuleiro e estratégia.',
      engine: 'wikipedia',
      engineRank: 3
    }
  ];

  const ranked = rerankCandidates(noisyPool, q, {
    plan,
    strictThreshold: true,
    count: 6
  });

  const urls = ranked.map((r) => r.url);
  assert.ok(urls.includes('https://liveuamap.com/'), 'Liveuamap atual deve ser retido');
  assert.ok(urls.includes('https://acleddata.com/conflict-index/'), 'ACLED atual deve ser retido');
  assert.ok(urls.includes('https://www.reuters.com/world/global-conflicts-live-updates-2026/'), 'Reuters atual deve ser retido');

  assert.equal(urls.some((u) => /Vietnam_War/i.test(u)), false, 'Guerra do Vietnã deve ser descartada');
  assert.equal(urls.some((u) => /6\.25|Korean/i.test(u)), false, 'Guerra da Coreia deve ser descartada');
  assert.equal(urls.some((u) => /1894|openalex/i.test(u)), false, 'Paper antigo de 1894/açúcar deve ser descartado');
  assert.equal(urls.some((u) => /Traidor/i.test(u)), false, 'Artigo de jogo deve ser descartado');
});

test('Eval-4: Golden Set Out-of-Distribution (10 queries inéditas) — classificação de intent, academic routing e 0x Microservices', () => {
  const cases = [
    {
      q: 'como configurar vacuum autovacuum postgresql 17',
      expectedIntent: 'howto_tech',
      expectedAcademic: false,
      expectedDomain: 'software_cs'
    },
    {
      q: 'diferença entre tokio spawn e spawn_blocking rust',
      expectedIntent: 'deep_research',
      expectedAcademic: true,
      expectedDomain: 'software_cs'
    },
    {
      q: 'CVE-2024-34351 mitigação nextjs',
      expectedIntent: 'secops',
      expectedAcademic: false,
      expectedDomain: 'software_cs'
    },
    {
      q: 'quais são os melhores livros sobre sistemas distribuídos',
      expectedIntent: 'deep_research',
      expectedAcademic: true,
      expectedDomain: 'general_research'
    },
    {
      q: 'o que é kademlia dht',
      expectedIntent: 'factual_short',
      expectedAcademic: false,
      expectedDomain: 'software_cs'
    },
    {
      q: 'quem ganhou o gp de interlagos hoje',
      expectedIntent: 'breaking_news',
      expectedAcademic: false,
      expectedDomain: 'general_research'
    },
    {
      q: 'docker multistage build rust musl alpine',
      expectedIntent: 'factual_short',
      expectedAcademic: false,
      expectedDomain: 'software_cs'
    },
    {
      q: 'análise comparativa arquitetura raft vs paxos consenso distribuído',
      expectedIntent: 'deep_research',
      expectedAcademic: true,
      expectedDomain: 'general_research'
    },
    {
      q: 'taxa selic banco central do brasil',
      expectedIntent: 'local_br',
      expectedAcademic: false,
      expectedDomain: 'general_research'
    },
    {
      q: 'erro ao compilar better-sqlite3 node 22',
      expectedIntent: 'howto_tech',
      expectedAcademic: false,
      expectedDomain: 'software_cs'
    }
  ];

  for (const tc of cases) {
    const plan = planSearchIntent(tc.q);
    const poles = buildMultiPolarQueries(tc.q);

    assert.equal(plan.intent, tc.expectedIntent, `Intent incorreto para "${tc.q}": recebido=${plan.intent}`);
    assert.equal(
      plan.shouldIncludeAcademic,
      tc.expectedAcademic,
      `shouldIncludeAcademic incorreto para "${tc.q}": recebido=${plan.shouldIncludeAcademic}`
    );
    assert.equal(plan.domain, tc.expectedDomain, `Domain incorreto para "${tc.q}": recebido=${plan.domain}`);

    const allPolesText = collectAllPoleStrings(poles);
    assert.doesNotMatch(
      allPolesText,
      /microservices?|microsservi[çc]os?|微服务|マイクロサービス|마이크로서비스|микросервис/i,
      `Sequestro para Microservices detectado na query "${tc.q}"`
    );
  }

  // Follow-up contextual só concatena quando há anáfora explícita (não concatena perguntas independentes)
  const prior = [{ question: 'Como funciona SQLite WAL?' }];
  const independent = buildContextualSearchQuery('Qual a capital do Japão?', prior, 'web');
  assert.equal(independent, 'Qual a capital do Japão?');
  const anaphoric = buildContextualSearchQuery('E qual o impacto disso em NVMe?', prior, 'web');
  assert.match(anaphoric, /SQLite WAL.*NVMe/);
});

// ============================================================================
// 2. CROSS-LINGUAL DEDUP (6 Wikipedias da mesma entidade -> exatamente 1)
// ============================================================================
test('Eval-5: Cross-Lingual Dedup colapsa 6 artigos Wikipedia da mesma entidade (QID e slug/transliteração) para exatamente 1', () => {
  // Caso A: via Wikidata QID compartilhado em 6 idiomas (incluindo CJK e Cirílico)
  const sixWikiQid = [
    { url: 'https://en.wikipedia.org/wiki/ModelScope', title: 'ModelScope — Wikipedia (EN)', wikidataId: 'Q123456', description: 'Alibaba Cloud open-source model-as-a-service community hosting LLMs and datasets.' },
    { url: 'https://zh.wikipedia.org/wiki/%E9%AD%94%E6%90%AD%E7%A4%BE%E5%8C%BA', title: '魔搭社区 — Wikipedia (ZH)', wikidataId: 'Q123456', description: '阿里云开源大模型社区' },
    { url: 'https://de.wikipedia.org/wiki/ModelScope', title: 'ModelScope — Wikipedia (DE)', wikidataId: 'Q123456', description: 'Chinesische KI-Plattform' },
    { url: 'https://ja.wikipedia.org/wiki/ModelScope', title: 'ModelScope — Wikipedia (JA)', wikidataId: 'Q123456', description: 'オープンソースAIモデルコミュニティ' },
    { url: 'https://ko.wikipedia.org/wiki/ModelScope', title: 'ModelScope — Wikipedia (KO)', wikidataId: 'Q123456', description: '오픈소스 AI 모델 허브' },
    { url: 'https://ru.wikipedia.org/wiki/ModelScope', title: 'ModelScope — Wikipedia (RU)', wikidataId: 'Q123456', description: 'Китайская платформа моделей ИИ' },
    { url: 'https://modelscope.cn/models', title: 'ModelScope Official Hub', description: 'Official Chinese open-source AI model hub.' }
  ];

  const dedupedQid = deduplicateResults(sixWikiQid, { searchLang: 'pt-BR', intent: 'deep_research' });
  const wikiAfterQid = dedupedQid.filter((item) => /wikipedia\.org/i.test(item.url));
  assert.equal(wikiAfterQid.length, 1, '6 Wikipedias com mesmo QID devem colapsar para exatamente 1');
  assert.equal(wikiAfterQid[0].mergedWikiLangs.length, 6);
  assert.equal(dedupedQid.length, 2, 'Deve manter o 1 artigo Wikipedia + a fonte não-Wikipedia');

  // Caso B: via slug normalizado e transliteração Cirílico <-> Latim (УВБ-76 === UVB-76) + mobile + tracking params
  const sixWikiSlug = [
    { url: 'https://en.m.wikipedia.org/wiki/UVB-76?utm_source=search&fbclid=abc', title: 'UVB-76 — Wikipedia (EN)', description: 'UVB-76, also known as The Buzzer, is a shortwave radio station broadcasting on 4625 kHz.' },
    { url: 'https://ru.wikipedia.org/wiki/%D0%A3%D0%92%D0%91-76', title: 'УВБ-76 — Wikipedia (RU)', description: 'Радиостанция УВБ-76 (Жужжалка) на частоте 4625 кГц.' },
    { url: 'https://de.wikipedia.org/wiki/UVB-76', title: 'UVB-76 — Wikipedia (DE)', description: 'Kurzwellensender' },
    { url: 'https://pt.wikipedia.org/wiki/UVB-76', title: 'UVB-76 — Wikipedia (PT)', description: 'Estação de rádio de ondas curtas.' },
    { url: 'https://ja.wikipedia.org/wiki/UVB-76', title: 'UVB-76 — Wikipedia (JA)', description: '短波放送局' },
    { url: 'https://zh.wikipedia.org/wiki/UVB-76', title: 'UVB-76 — Wikipedia (ZH)', description: '短波电台' }
  ];

  assert.equal(normalizeEntitySlug('УВБ-76'), 'uvb76');
  assert.equal(normalizeEntitySlug('UVB-76'), 'uvb76');

  const dedupedSlug = deduplicateResults(sixWikiSlug, { searchLang: 'pt-BR', intent: 'deep_research' });
  assert.equal(dedupedSlug.length, 1, '6 Wikipedias da mesma entidade (slug/transliteração) devem colapsar para 1');
  assert.doesNotMatch(dedupedSlug[0].url, /utm_source|fbclid|\.m\.wikipedia/);

  // Canonical URL limpa tracking params e normaliza host/barra
  const canon = canonicalizeUrl('https://WWW.Example.org/docs/guide/?utm_medium=cpc&b=2&a=1&gclid=xyz#section');
  assert.equal(canon.canonicalKey, 'example.org/docs/guide?a=1&b=2');
  assert.doesNotMatch(canon.url, /utm_medium|gclid|#/);
});

// ============================================================================
// 3. NER BRAND PROTECTION & TTL CACHE (src/search/translator.js)
// ============================================================================
test('Eval-6: NER Brand Protection preserva Hugging Face, ModelScope, BackBox, Linux, UVB-76, owner/repo e CVE-2025-1234', () => {
  const input =
    'Comparing Hugging Face with ModelScope, BackBox Linux forensic tools, UVB-76 logs, alibaba/modelscope and CVE-2025-1234 mitigation';
  const { masked, placeholders } = protectEntities(input);

  // Todas as entidades sensíveis foram mascaradas antes de enviar ao tradutor
  for (const entity of ['Hugging Face', 'ModelScope', 'BackBox', 'Linux', 'UVB-76', 'alibaba/modelscope', 'CVE-2025-1234']) {
    assert.equal(masked.includes(entity), false, `Entidade "${entity}" deveria estar mascarada em masked="${masked}"`);
  }
  assert.ok(placeholders.length >= 6);

  // Simula o tradutor alterando apenas o texto em volta (e até inserindo espaços ao redor dos placeholders)
  const simulatedTranslation = masked
    .replace('Comparing', 'Comparando')
    .replace('with', 'com')
    .replace('forensic tools', 'ferramentas forenses')
    .replace('logs, ', 'registros, ')
    .replace('and', 'e')
    .replace('mitigation', 'mitigação')
    .replace(/ZXQ(\d+)ZXQ/g, 'ZXQ $1 ZXQ');

  const restored = restoreEntities(simulatedTranslation, placeholders, 'pt');
  for (const entity of ['Hugging Face', 'ModelScope', 'BackBox Linux', 'UVB-76', 'alibaba/modelscope', 'CVE-2025-1234']) {
    assert.ok(restored.includes(entity), `Entidade "${entity}" deve ser restaurada intacta (resultado: "${restored}")`);
  }

  // Fallback defensivo caso tradutor externo gere traduções literais quebradas
  const repaired = restoreEntities(
    'Guia da Caixa traseira e Escopo do modelo concorrente de Abraçando o rosto na Fundição Palantir sobre Knowledge Graphs',
    [],
    'pt'
  );
  assert.match(repaired, /BackBox/);
  assert.match(repaired, /ModelScope/);
  assert.match(repaired, /Hugging Face/);
  assert.match(repaired, /Palantir Foundry/);
  assert.match(repaired, /Grafos de Conhecimento/);

  // TtlCache LRU + expiração
  const cache = new TtlCache({ ttlMs: 50, maxEntries: 2 });
  cache.set('k1', 'v1');
  cache.set('k2', 'v2');
  assert.equal(cache.get('k1'), 'v1'); // refresca LRU -> k2 é o mais antigo
  cache.set('k3', 'v3');
  assert.equal(cache.size, 2);
  assert.equal(cache.has('k2'), false);
  assert.equal(cache.get('k1'), 'v1');
  assert.equal(cache.get('k3'), 'v3');
});

// ============================================================================
// 4. QUERY-FOCUSED PASSAGE SELECTION & BODY LIMIT (src/extractor.js)
// ============================================================================
test('Eval-7: Query-Focused Passage Selection recupera resposta no final de artigo > 10.000 chars dentro de <= 2400 chars', async () => {
  const fillerSections = Array.from({ length: 24 }, (_, idx) => {
    return `
      <h2>Background Chapter ${idx + 1}: General Networking History</h2>
      <p>Throughout early computing decades, regional universities exchanged batch magnetic tapes and teletype schedules across telephone trunks. Documentation archives cataloged hardware cabling layouts, rack temperatures, cooling fan acoustic profiles, and standard office maintenance procedures without referencing specialized forensic toolkits or disk carving utilities.</p>
    `;
  }).join('\n');

  const targetSection = `
    <h2>Forensic Analysis and Data Recovery Tools</h2>
    <p>BackBox Linux ships preinstalled with TestDisk, PhotoRec, Foremost, Scalpel, and Autopsy inside its Forensic Analysis menu for non-destructive partition recovery and file carving on ext4, NTFS, and FAT filesystems.</p>
  `;

  const longHtml = `<!DOCTYPE html>
  <html lang="en">
    <head><title>BackBox Linux Complete Manual</title></head>
    <body>
      <main>
        <article>
          <h1>BackBox Linux Complete Manual</h1>
          ${fillerSections}
          ${targetSection}
        </article>
      </main>
    </body>
  </html>`;

  assert.ok(longHtml.length > 10000, `HTML de teste deve ter > 10.000 chars (atual: ${longHtml.length})`);

  const focused = selectQueryFocusedPassages(longHtml, 'BackBox Linux data recovery tools TestDisk PhotoRec', 2400);
  assert.ok(focused.length <= 2400, `Passagem focada deve caber em <= 2400 chars (atual: ${focused.length})`);
  assert.match(focused, /TestDisk/i);
  assert.match(focused, /PhotoRec/i);
  assert.match(focused, /Foremost/i);
  assert.match(focused, /Scalpel/i);

  // Teste integrado em extractReadablePage com query
  const extracted = await extractReadablePage('https://docs.backbox.org/manual', 'BackBox Manual', {
    query: 'qual software vem no backbox linux para data recovery',
    requestFn: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Readable.from([Buffer.from(longHtml, 'utf-8')])
    })
  });
  assert.ok(extracted);
  assert.ok(extracted.excerpt.length <= 2400);
  assert.match(extracted.excerpt, /TestDisk.*PhotoRec/);

  // readBodyWithLimit corta stream acima de maxBytes e chama destroy()
  let destroyed = false;
  const hugeStream = Readable.from([Buffer.alloc(1024, 'A'), Buffer.alloc(1024, 'B'), Buffer.alloc(1024, 'C')]);
  hugeStream.destroy = () => {
    destroyed = true;
  };
  const limited = await readBodyWithLimit(hugeStream, 1500, 'text/plain; charset=utf-8');
  assert.equal(limited.length, 1500);
  assert.equal(destroyed, true, 'readBodyWithLimit deve chamar body.destroy() ao exceder limite');
});

// ============================================================================
// 5. ADAPTIVE RESPONSE LENGTH + ABSTENTION + VERIFY CITATION GROUNDING
// ============================================================================
test('Eval-8: Adaptive Response Length, regra de abstinência no system prompt e verifyCitationGrounding', () => {
  // 5.1 Perfis adaptativos
  const shortProfile = classifyResponseProfile('qual o software que vem no backbox linux?');
  assert.equal(shortProfile.intent, 'factual_short');
  assert.equal(shortProfile.numPredict, 750);

  const deepProfile = classifyResponseProfile('análise comparativa arquitetura raft vs paxos trade-offs');
  assert.equal(deepProfile.intent, 'deep_research');
  assert.equal(deepProfile.numPredict, 1800);

  const howtoProfile = classifyResponseProfile('como configurar autovacuum postgresql 17');
  assert.equal(howtoProfile.intent, 'howto_tech');
  assert.equal(howtoProfile.numPredict, 1200);

  const newsProfile = classifyResponseProfile('mapa de conflitos hoje guerra');
  assert.equal(newsProfile.intent, 'breaking_news');
  assert.equal(newsProfile.numPredict, 1000);

  // 5.2 Regra inegociável de abstinência presente no system prompt
  const sysPromptShort = buildSystemPrompt(4, 'pt-BR', shortProfile);
  const sysPromptDeep = buildSystemPrompt(4, 'pt-BR', deepProfile);
  assert.match(sysPromptShort, /REGRA INEGOCIÁVEL DE ABSTINÊNCIA/i);
  assert.match(sysPromptShort, /SE AS FONTES FORNECIDAS NÃO CONTIVEREM A RESPOSTA EXATA/i);
  assert.match(sysPromptShort, /PERFIL FACTUAL DIRETO/i);
  assert.match(sysPromptDeep, /PERFIL PESQUISA PROFUNDA/i);
  assert.match(buildSystemPrompt(0, 'pt-BR'), /NUNCA invente citações como \[1\]/i);

  // 5.3 verifyCitationGrounding distingue citações suportadas (>= 0.8) de alucinadas (=== 0)
  const sources = [
    {
      citationIndex: 1,
      title: 'Write-Ahead Logging — SQLite Official Documentation',
      domain: 'sqlite.org',
      excerpt: 'SQLite WAL mode provides significantly faster concurrent reads because readers do not block writers and writers do not block readers.'
    },
    {
      citationIndex: 2,
      title: 'BackBox Linux Forensic Tools',
      domain: 'backbox.org',
      excerpt: 'BackBox Linux includes TestDisk, PhotoRec, Foremost and Scalpel for digital forensics and data recovery.'
    }
  ];

  const groundedAnswer = [
    'O modo **WAL** no SQLite permite leituras concorrentes sem bloquear escritores [1].',
    'No BackBox Linux, as ferramentas TestDisk, PhotoRec e Foremost são incluídas para recuperação de dados [2].'
  ].join('\n');

  const okReport = verifyCitationGrounding(groundedAnswer, sources);
  assert.equal(okReport.totalCitations, 2);
  assert.equal(okReport.verifiedCitations, 2);
  assert.equal(okReport.unverifiedCitations, 0);
  assert.ok(okReport.faithfulnessScore >= 0.8, `Score esperado >= 0.8 (recebido: ${okReport.faithfulnessScore})`);

  const hallucinatedAnswer = [
    'Em 1998 a agência espacial lançou o satélite Saturno IX com 4200 turbinas criogênicas em Marte [1].',
    'A receita tradicional de croissant francês utiliza 850 gramas de manteiga fermentada de Normandia [2].'
  ].join('\n');

  const badReport = verifyCitationGrounding(hallucinatedAnswer, sources);
  assert.equal(badReport.totalCitations, 2);
  assert.equal(badReport.verifiedCitations, 0);
  assert.equal(badReport.unverifiedCitations, 2);
  assert.equal(badReport.faithfulnessScore, 0);
  assert.equal(badReport.warnings.length, 2);

  // 5.4 Token budgeting (CJK vs Latim) e sanitizador incremental O(N)
  assert.ok(estimateTokenCount('数据库架构设计方案') > estimateTokenCount('database'));
  const hugeSources = [
    { citationIndex: 1, title: 'S1', url: 'https://a.org', domain: 'a.org', excerpt: 'word '.repeat(6000) },
    { citationIndex: 2, title: 'S2', url: 'https://b.org', domain: 'b.org', excerpt: 'short excerpt.' }
  ];
  const budgeted = fitSourcesToTokenBudget(hugeSources, 2048);
  assert.equal(budgeted.length, 2);
  assert.ok(budgeted[0].excerpt.length < hugeSources[0].excerpt.length);
  assert.equal(budgeted[1].excerpt, 'short excerpt.');

  const incSanitizer = createIncrementalCitationSanitizer(2);
  incSanitizer.push('<think>raciocínio interno secreto [1]</think>');
  incSanitizer.push('Fato comprovado [1, 2] ');
  incSanitizer.push('e citação inválida [9].');
  assert.equal(incSanitizer.finalize(true), 'Fato comprovado [1][2] e citação inválida .');
});

test('Eval-8b: listOllamaModels filtra modelos de embedding com cache TTL e translateTurnMarkdown preserva citações', async () => {
  clearOllamaModelsCache();
  let tagCalls = 0;
  const mockTagReq = async () => {
    tagCalls += 1;
    return {
      statusCode: 200,
      body: {
        json: async () => ({
          models: [
            { name: 'bge-m3:latest', size: 1200000000 },
            { name: 'nomic-embed-text:latest', size: 500000000 },
            { name: 'granite4.2-uncensored:latest', size: 5400000000 },
            { name: 'qwen3.8-uncensored:9b', size: 6100000000 }
          ]
        })
      }
    };
  };

  const models1 = await listOllamaModels({
    env: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'granite4.2-uncensored:latest' },
    requestFn: mockTagReq
  });
  const models2 = await listOllamaModels({
    env: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'granite4.2-uncensored:latest' },
    requestFn: mockTagReq
  });
  assert.equal(tagCalls, 1, 'Segunda chamada dentro do TTL 30s deve usar cache');
  assert.equal(models1.length, 2);
  assert.equal(models2.length, 2);
  assert.equal(models1[0].name, 'granite4.2-uncensored:latest');
  assert.equal(models1.some((m) => /bge-m3|embed/i.test(m.name)), false);

  const translated = await translateTurnMarkdown({
    markdownText: 'BackBox ships **TestDisk** [1] and **PhotoRec** [2].',
    targetLang: 'pt-BR',
    sources: [{ citationIndex: 1 }, { citationIndex: 2 }],
    customTranslateFn: async () => 'O BackBox inclui **TestDisk** [1] e **PhotoRec** [2] e ignora [9].'
  });
  assert.equal(translated.targetLang, 'pt-BR');
  assert.equal(translated.text, 'O BackBox inclui **TestDisk** [1] e **PhotoRec** [2] e ignora .');
});

// ============================================================================
// 6. QDRANT V2 1024D & ANTI-MODEL-COLLAPSE (src/qdrant.js)
// ============================================================================
test('Eval-9: Qdrant v2 1024d nativo, zero fallback SHA-256, score_threshold e local.deepevil.memory explícito', async () => {
  assert.equal(DEFAULT_VECTOR_SIZE, 1024);
  assert.equal(DEFAULT_COLLECTION, 'deepevil_conversations_v2');
  assert.equal(DEFAULT_SCORE_THRESHOLD, 0.68);

  // 6.1 Zero fallback SHA-256 quando Ollama /api/embed falha ou dá timeout
  const failedEmbed = await embedTextSemantic('consulta semântica', {
    env: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' },
    requestFn: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  assert.equal(failedEmbed, null, 'Falha no embed DEVE retornar null (zero fallback SHA-256)');

  const http500Embed = await embedTextSemantic('consulta semântica', {
    env: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' },
    requestFn: async () => ({ statusCode: 500, body: { dump: async () => {} } })
  });
  assert.equal(http500Embed, null);

  // 6.2 embedTextsBatch retorna 1024d L2-normalizados em 1 chamada HTTP
  const vecA = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0.01));
  const vecB = Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0.01));
  let batchCalls = 0;
  const batchVecs = await embedTextsBatch(['texto 1', 'texto 2'], {
    requestFn: async () => {
      batchCalls += 1;
      return { statusCode: 200, body: { json: async () => ({ embeddings: [vecA, vecB] }) } };
    }
  });
  assert.equal(batchCalls, 1);
  assert.equal(batchVecs.length, 2);
  assert.equal(batchVecs[0].length, 1024);
  assert.ok(cosineSimilarity(batchVecs[0], batchVecs[0]) > 0.99);

  // 6.3 Store Qdrant v2: cria coleção 1024d, bloqueia indexTurn em falha de embed e em lowFidelity,
  // envia score_threshold e marca memória local como local.deepevil.memory (sem URL externa mascarada)
  let qdrantPutPointsCalls = 0;
  let capturedSearchPayloads = [];
  let createdCollectionConfig = null;
  let failEmbedNow = false;

  const mockQdrantRequest = async (url, opts = {}) => {
    if (url.endsWith('/api/embed')) {
      if (failEmbedNow) {
        return { statusCode: 503, body: { dump: async () => {} } };
      }
      return { statusCode: 200, body: { json: async () => ({ embeddings: [vecA] }) } };
    }
    if (url.endsWith('/collections') && opts.method === 'GET') {
      return { statusCode: 200, body: { dump: async () => {} } };
    }
    if (url.endsWith(`/collections/${DEFAULT_COLLECTION}`) && opts.method === 'GET') {
      return { statusCode: 404, body: { dump: async () => {} } };
    }
    if (url.endsWith(`/collections/${DEFAULT_COLLECTION}`) && opts.method === 'PUT') {
      createdCollectionConfig = JSON.parse(opts.body);
      return { statusCode: 200, body: { dump: async () => {} } };
    }
    if (url.includes('/points?wait=true') && opts.method === 'PUT') {
      qdrantPutPointsCalls += 1;
      return { statusCode: 200, body: { dump: async () => {} } };
    }
    if (url.includes('/points/delete?wait=true') && opts.method === 'POST') {
      return { statusCode: 200, body: { dump: async () => {} } };
    }
    if (url.endsWith(`/collections/${DEFAULT_COLLECTION}/points/search`) && opts.method === 'POST') {
      const parsedBody = JSON.parse(opts.body);
      capturedSearchPayloads.push(parsedBody);
      if (parsedBody.score_threshold >= 0.9) {
        return {
          statusCode: 200,
          body: {
            json: async () => ({
              result: [
                {
                  id: 88,
                  score: 0.95,
                  payload: {
                    turn_id: 88,
                    conversation_id: 9,
                    question: 'Qual ferramenta de data recovery vem no BackBox?',
                    answer_markdown: 'BackBox Linux traz TestDisk e PhotoRec [1].',
                    status: 'completed',
                    faithfulness_score: 0.95,
                    search_lang: 'pt-BR',
                    focus_mode: 'web',
                    model: 'granite4.2-uncensored:latest',
                    provider: 'ollama',
                    sources: [
                      {
                        citationIndex: 1,
                        url: 'https://www.backbox.org/tools/',
                        title: 'BackBox Official Tools',
                        domain: 'backbox.org',
                        excerpt: 'BackBox Linux ships TestDisk, PhotoRec, Foremost and Scalpel for digital forensics and data recovery.'
                      }
                    ],
                    updated_at: new Date().toISOString()
                  }
                }
              ]
            })
          }
        };
      }
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            result: [
              {
                id: 77,
                score: 0.89,
                payload: {
                  turn_id: 77,
                  conversation_id: 9,
                  question: 'Qual ferramenta de data recovery vem no BackBox?',
                  answer_markdown:
                    'BackBox Linux inclui TestDisk, PhotoRec, Foremost e Scalpel para recuperação forense de arquivos deletados e partições.',
                  status: 'completed',
                  sources: [],
                  updated_at: new Date().toISOString()
                }
              },
              {
                id: 78,
                score: 0.86,
                payload: {
                  turn_id: 78,
                  conversation_id: 9,
                  question: 'Ferramentas forenses BackBox',
                  answer_markdown: 'Resumo interno',
                  status: 'completed',
                  sources: [
                    {
                      citationIndex: 1,
                      url: 'https://www.cgsecurity.org/wiki/TestDisk',
                      title: 'TestDisk — CGSecurity',
                      domain: 'cgsecurity.org',
                      excerpt: 'TestDisk is a powerful free open-source data recovery software designed to recover lost partitions and non-booting disks.'
                    }
                  ],
                  updated_at: new Date().toISOString()
                }
              }
            ]
          })
        }
      };
    }
    if (url.includes('/collections/pe-agents-ibm-context')) {
      return { statusCode: 404, body: { dump: async () => {} } };
    }
    return { statusCode: 404, body: { dump: async () => {} } };
  };

  const store = createQdrantStore({
    env: { QDRANT_URL: 'http://127.0.0.1:6333', OLLAMA_BASE_URL: 'http://127.0.0.1:11434' },
    requestFn: mockQdrantRequest
  });

  // Check health cria coleção 1024d Cosine
  const health = await store.checkHealth();
  assert.equal(health.online, true);
  assert.equal(health.vectorSize, 1024);
  assert.equal(createdCollectionConfig.vectors.size, 1024);
  assert.equal(createdCollectionConfig.vectors.distance, 'Cosine');

  // Low-fidelity turn (via lowFidelity: true OU citationVerification) NÃO pode ser indexado no Qdrant!
  const skippedLowFid = await store.indexTurn({
    conversation: { id: 1, title: 'Teste' },
    turn: { id: 10, conversation_id: 1, question: 'Q', answer_markdown: 'Alucinação [1]', status: 'completed' },
    sources: [{ citationIndex: 1, url: 'https://example.org', title: 'Ex', domain: 'example.org', excerpt: 'Outro tema' }],
    lowFidelity: true,
    groundingScore: 0
  });
  assert.equal(skippedLowFid, null);
  assert.equal(qdrantPutPointsCalls, 0);

  // Falha de embed -> zero upsert (sem SHA-256!)
  failEmbedNow = true;
  const skippedNoEmbed = await store.indexTurn({
    conversation: { id: 1, title: 'Teste' },
    turn: { id: 11, conversation_id: 1, question: 'Q', answer_markdown: 'Válido [1]', status: 'completed' },
    sources: [{ citationIndex: 1, url: 'https://example.org', title: 'Ex', domain: 'example.org', excerpt: 'Válido' }]
  });
  assert.equal(skippedNoEmbed, null);
  assert.equal(qdrantPutPointsCalls, 0);

  // Embed funcionando -> upsert 1024d com sucesso
  failEmbedNow = false;
  const indexedOk = await store.indexTurn({
    conversation: { id: 1, title: 'Teste' },
    turn: { id: 12, conversation_id: 1, question: 'Q', answer_markdown: 'Válido [1]', status: 'completed' },
    sources: [{ citationIndex: 1, url: 'https://example.org', title: 'Ex', domain: 'example.org', excerpt: 'Válido' }],
    citationVerification: { totalCitations: 1, verifiedCitations: 1, unverifiedCitations: 0, faithfulnessScore: 1 }
  });
  assert.equal(indexedOk, true);
  assert.equal(qdrantPutPointsCalls, 1);

  // searchHybridSources envia score_threshold=0.68, marca memória local como local.deepevil.memory
  // e devolve trechos verificados de fontes web arquivadas quando disponíveis
  const hybridHits = await store.searchHybridSources('backbox data recovery', 2);
  assert.ok(capturedSearchPayloads.length >= 1);
  assert.equal(capturedSearchPayloads[0].score_threshold, 0.68);
  assert.equal(hybridHits.length, 2);
  assert.equal(hybridHits[0].domain, 'local.deepevil.memory');
  assert.equal(hybridHits[0].isLocalMemory, true);
  assert.equal(hybridHits[0].url, 'https://local.deepevil.memory/turn/77');
  assert.equal(hybridHits[1].url, 'https://www.cgsecurity.org/wiki/TestDisk');
  assert.equal(hybridHits[1].fromQdrantArchive, true);

  // searchKnowledge + deleteConversationPoints + findSemanticCacheHit
  const kbHits = await store.searchKnowledge('backbox data recovery', 5, { scoreThreshold: 0.7 });
  assert.ok(kbHits.length >= 1);
  assert.equal(await store.deleteConversationPoints(9), true);

  const cacheHit = await store.findSemanticCacheHit('Qual ferramenta de data recovery vem no BackBox?', {
    searchLang: 'pt-BR',
    focusMode: 'web'
  });
  assert.ok(cacheHit);
  assert.equal(cacheHit.hit, true);
  assert.equal(cacheHit.turnId, 88);

  // findSemanticCacheHit ignora queries com freshness day/week
  assert.equal(await store.findSemanticCacheHit('mapa de conflitos hoje', { freshness: 'day' }), null);
  assert.equal(await store.findSemanticCacheHit('notícias desta semana', { freshness: 'week' }), null);

  // rerankCandidates para howto_tech e code_repo prioriza docs técnicos sobre acadêmicos
  const howtoRanked = rerankCandidates(
    [
      { url: 'https://openalex.org/W999', title: 'Academic paper on BackBox', description: 'Theoretical study.', engine: 'openalex', engineRank: 1 },
      { url: 'https://www.backbox.org/tools/', title: 'BackBox Linux Data Recovery Tools', description: 'TestDisk PhotoRec Foremost included in BackBox Linux.', engine: 'searxng', engineRank: 1 }
    ],
    'qual o software que vem no backbox linux para recuperação de dados',
    { strictThreshold: true }
  );
  assert.equal(howtoRanked[0].url, 'https://www.backbox.org/tools/');

  // rerankCandidatesAsync com semantic fallback transparente quando embedTextsBatch indisponível/desativado
  const asyncRanked = await rerankCandidatesAsync(
    [
      { url: 'https://docs.rs/tokio', title: 'Tokio Rust Async Runtime', description: 'tokio spawn and spawn_blocking documentation', engine: 'searxng', engineRank: 1 }
    ],
    'diferença entre tokio spawn e spawn_blocking rust',
    { enableSemantic: false }
  );
  assert.equal(asyncRanked.length, 1);
});

// ============================================================================
// 7. UX / MARKDOWN `marked` / WCAG 2.1 AA (src/render.js)
// ============================================================================
test('Eval-10: UX, Markdown marked e WCAG 2.1 AA (Skip Link, 0 hx-ext sse, Combobox, aria-live, code fence, table scope, inline code)', () => {
  // 7.1 renderFullPage
  const pageHtml = renderFullPage({
    conversations: [{ id: 1, title: 'Pesquisa BackBox', turn_count: 1, updated_at: new Date().toISOString() }],
    activeConversation: null,
    envStatus: {
      provider: 'ollama',
      model: 'granite4.2-uncensored:latest',
      models: [
        { name: 'granite4.2-uncensored:latest', sizeGb: '5.1' },
        { name: 'qwen3.8-uncensored:9b', sizeGb: '6.2' }
      ]
    }
  });

  assert.match(pageHtml, /class="skip-link"/, 'Deve conter Skip Link WCAG 2.4.1');
  assert.match(pageHtml, /href="#main-stage"/);
  assert.doesNotMatch(pageHtml, /hx-ext\s*=\s*["']sse["']/i, 'ZERO hx-ext="sse" permitido');
  assert.doesNotMatch(pageHtml, /\bsse-connect\s*=/i, 'ZERO sse-connect permitido');
  assert.match(pageHtml, /id="model-combobox-input"/, 'Deve conter combobox pesquisável de modelos');
  assert.match(pageHtml, /role="combobox"/);
  assert.match(pageHtml, /role="listbox"/);
  assert.doesNotMatch(pageHtml, /\+\s*\+\s*Nova Pesquisa/, 'Não pode duplicar "+ + Nova Pesquisa"');

  // Top Sources Strip: zero "US US" duplicado no texto visível
  const stripHtml = renderTopSourcesStrip(5, [
    { citationIndex: 1, domain: 'nvd.nist.gov', title: '[🇺🇸 US] NVD Advisory CVE-2024-34351', countryPole: 'US' }
  ]);
  assert.match(stripHtml, /data-pole="US">US<\/span>/);
  assert.match(stripHtml, /<span class="top-source-title">NVD Advisory CVE-2024-34351<\/span>/);
  assert.doesNotMatch(stripHtml, />\s*US\s+US\s*</, 'Não pode duplicar badge "US US"');

  // 7.2 renderTurnCard: role="status" + aria-live="polite" no status, NUNCA aria-live no #turn-answer-
  const liveCard = renderTurnCard(
    {
      id: 42,
      question: 'Como configurar autovacuum no PostgreSQL 17?',
      search_query: 'postgresql 17 autovacuum configuration',
      status: 'streaming',
      provider: 'ollama',
      model: 'granite4.2-uncensored:latest',
      answer_markdown: '',
      sources: []
    },
    { isLive: true }
  );

  assert.match(liveCard, /data-stream-turn="42"/);
  assert.doesNotMatch(liveCard, /hx-ext="sse"/);
  assert.doesNotMatch(liveCard, /sse-connect=/);
  assert.match(liveCard, /id="turn-status-42"[^>]*role="status"[^>]*aria-live="polite"/);
  const answerTagMatch = liveCard.match(/<section\s+id="turn-answer-42"[^>]*>/);
  assert.ok(answerTagMatch, 'Deve renderizar #turn-answer-42');
  assert.doesNotMatch(
    answerTagMatch[0],
    /aria-live=/i,
    '#turn-answer- NUNCA pode ter aria-live (causa spam de leitores de tela durante streaming)'
  );

  // 7.3 renderAnswerMarkdownWithFootnotes: pre/code multi-linha + copy button, fence aberto, table th scope="col", inline code protegido
  const sources = [
    {
      citationIndex: 1,
      url: 'https://www.postgresql.org/docs/17/routine-vacuuming.html',
      title: 'PostgreSQL 17 Autovacuum Docs',
      domain: 'postgresql.org',
      excerpt: 'Autovacuum daemon automates VACUUM and ANALYZE execution.'
    }
  ];

  const richMd = [
    'Use `inline [1] code` sem alterar o colchete, mas cite fora do código [1].',
    '',
    '| Parâmetro | Padrão |',
    '| --- | --- |',
    '| `autovacuum_naptime` | 1min [1] |',
    '',
    '```sql',
    'ALTER TABLE eventos SET (',
    '  autovacuum_vacuum_scale_factor = 0.05',
    ');',
    '```'
  ].join('\n');

  const renderedRich = renderAnswerMarkdownWithFootnotes(richMd, 88, sources);
  assert.match(renderedRich, /<code class="inline-code">inline \[1\] code<\/code>/, 'Inline code com [1] deve ficar intocado');
  assert.match(renderedRich, /href="#source-88-1"/, 'Citação [1] fora de inline code deve virar link de rodapé');
  assert.match(renderedRich, /<div class="answer-table-wrap"[^>]*role="region"[^>]*tabindex="0">/);
  assert.match(renderedRich, /<th scope="col">Parâmetro<\/th>/);
  assert.match(renderedRich, /<th scope="col">Padrão<\/th>/);
  assert.match(renderedRich, /data-copy-code="1"/, 'Bloco de código deve ter botão de copiar');
  assert.match(
    renderedRich,
    /<pre class="code-block" data-lang="sql"><code>ALTER TABLE eventos SET \(\n  autovacuum_vacuum_scale_factor = 0\.05\n\);<\/code><\/pre>/,
    'Bloco <pre><code> multi-linha deve preservar quebras de linha'
  );

  // Code fence aberto em streaming SSE fecha virtualmente sem lixo ```
  const streamingOpenFence = 'Configuração recomendada [1]:\n\n```rust\nasync fn main() {\n    tokio::spawn(work());';
  const renderedStreaming = renderAnswerMarkdownWithFootnotes(streamingOpenFence, 89, sources);
  assert.match(renderedStreaming, /<pre class="code-block" data-lang="rust"><code>async fn main\(\) \{\n    tokio::spawn\(work\(\)\);<\/code><\/pre>/);
  assert.doesNotMatch(renderedStreaming, /```/, 'Fence aberto em streaming deve ser fechado virtualmente sem vazar ``` cru');
});

test('Eval-11: Federação Retrieval-First (collectMultiPolarFederation) respeita roteamento por intenção sem vazar acadêmicos em breaking_news/howto_tech', async () => {
  const createFederationMock = (calledUrls) => async (url) => {
    calledUrls.push(url);
    if (url.includes('news.google.com/rss')) {
      return {
        statusCode: 200,
        body: {
          text: async () => `<?xml version="1.0" encoding="UTF-8"?>
            <rss><channel>
              <item>
                <title>Live Conflict Map Update 2026 - Reuters</title>
                <link>https://www.reuters.com/world/conflict-map-live-2026/</link>
                <pubDate>Fri, 20 Nov 2026 12:00:00 GMT</pubDate>
                <description>Current active armed conflicts and live war tracker updated today 2026.</description>
              </item>
            </channel></rss>`
        }
      };
    }
    if (url.includes('api.github.com/search/repositories')) {
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            items: [
              {
                full_name: 'cgsecurity/testdisk',
                html_url: 'https://github.com/cgsecurity/testdisk',
                description: 'TestDisk and PhotoRec data recovery tools included in BackBox Linux.',
                stargazers_count: 1500,
                language: 'C'
              },
              {
                full_name: 'hashicorp/raft',
                html_url: 'https://github.com/hashicorp/raft',
                description: 'Golang implementation of the Raft distributed consensus protocol vs Paxos.',
                stargazers_count: 8500,
                language: 'Go'
              }
            ]
          })
        }
      };
    }
    if (url.includes('hn.algolia.com')) {
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            hits: [
              {
                objectID: '424242',
                title: 'Raft vs Paxos Distributed Consensus Trade-offs',
                url: 'https://raft.github.io/',
                points: 420,
                num_comments: 95
              }
            ]
          })
        }
      };
    }
    if (url.includes('api.openalex.org')) {
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            results: [
              {
                id: 'https://openalex.org/W4200001',
                doi: 'https://doi.org/10.1145/raft-paxos',
                title: 'In Search of an Understandable Consensus Algorithm: Raft vs Paxos',
                publication_year: 2024,
                abstract_inverted_index: {
                  Raft: [0],
                  consensus: [1],
                  algorithm: [2],
                  compared: [3],
                  to: [4],
                  Paxos: [5],
                  distributed: [6],
                  systems: [7]
                }
              }
            ]
          })
        }
      };
    }
    if (url.includes('export.arxiv.org')) {
      return {
        statusCode: 200,
        body: {
          text: async () => `<?xml version="1.0" encoding="UTF-8"?>
            <feed><entry>
              <id>http://arxiv.org/abs/2501.12345v1</id>
              <title>Formal Comparison of Raft and Paxos Consensus</title>
              <summary>Detailed architecture comparison of Raft and Paxos consensus protocols in distributed systems.</summary>
            </entry></feed>`
        }
      };
    }
    if (url.includes('api.crossref.org')) {
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            message: {
              items: [
                {
                  DOI: '10.1109/raft.2025.01',
                  URL: 'https://doi.org/10.1109/raft.2025.01',
                  title: ['Distributed Consensus Architecture: Raft and Paxos'],
                  abstract: '<p>Comparative analysis of Raft and Paxos fault tolerance in distributed consensus.</p>'
                }
              ]
            }
          })
        }
      };
    }
    if (url.includes('wikipedia.org/w/api.php')) {
      return {
        statusCode: 200,
        body: {
          json: async () => ({
            query: {
              pages: {
                '101': {
                  title: 'BackBox',
                  extract: 'BackBox is an Ubuntu-based Linux distribution for penetration testing and digital forensics including TestDisk and PhotoRec.',
                  pageprops: { wikibase_item: 'Q4034770' }
                }
              }
            }
          })
        }
      };
    }
    if (url.includes('bing.com/search')) {
      return {
        statusCode: 200,
        body: {
          text: async () => `<html><body>
            <li class="b_algo">
              <h2><a href="https://www.backbox.org/tools/">BackBox Linux Data Recovery &amp; Forensic Tools</a></h2>
              <p>BackBox Linux includes TestDisk, PhotoRec, Foremost and Scalpel for data recovery.</p>
            </li>
            <li class="b_algo">
              <h2><a href="https://liveuamap.com/">Liveuamap — Live Conflict Map Today 2026</a></h2>
              <p>Real-time map of active armed conflicts and wars around the world today.</p>
            </li>
          </body></html>`
        }
      };
    }
    return { statusCode: 404, body: { dump: async () => {}, text: async () => '' } };
  };

  // 1. breaking_news -> NÃO dispara OpenAlex/ArXiv/CrossRef/Wikipedia, consulta busca web orgânica
  const newsUrls = [];
  const newsRes = await collectMultiPolarFederation('mapa de conflitos hoje guerra', {
    httpRequest: createFederationMock(newsUrls),
    timeoutMs: 2500
  });
  assert.ok(newsRes.length >= 1);
  assert.equal(newsUrls.some((u) => /openalex\.org|crossref\.org|arxiv\.org|wikipedia\.org/i.test(u)), false);
  assert.equal(newsUrls.some((u) => /bing\.com\/search/i.test(u)), true);

  // 2. howto_tech -> NÃO dispara OpenAlex/CrossRef/ArXiv nem multi-wiki CJK/RU/DE, consulta GitHub/Bing/light-wiki
  const howtoUrls = [];
  const howtoRes = await collectMultiPolarFederation(
    'qual o software que vem no backbox linux para recuperação de dados',
    { httpRequest: createFederationMock(howtoUrls), timeoutMs: 2500 }
  );
  assert.ok(howtoRes.length >= 1);
  assert.equal(howtoUrls.some((u) => /openalex\.org|crossref\.org|arxiv\.org/i.test(u)), false);
  assert.equal(howtoUrls.some((u) => /(?:zh|de|ja|ko|ru)\.wikipedia\.org/i.test(u)), false);
  assert.equal(howtoUrls.some((u) => /api\.github\.com/i.test(u)), true);
  assert.ok(howtoRes.some((r) => /backbox|testdisk/i.test(`${r.title} ${r.url}`)));

  // 3. deep_research (software_cs) -> dispara provedores acadêmicos (OpenAlex + ArXiv) + code + multi-wiki e funde resultados
  const deepUrls = [];
  const deepRes = await collectMultiPolarFederation(
    'análise comparativa arquitetura raft vs paxos consenso distribuído em rust',
    { httpRequest: createFederationMock(deepUrls), timeoutMs: 2500 }
  );
  assert.ok(deepRes.length >= 2);
  assert.equal(deepUrls.some((u) => /openalex\.org/i.test(u)), true);
  assert.equal(deepUrls.some((u) => /arxiv\.org/i.test(u)), true);
  assert.equal(deepUrls.some((u) => /api\.github\.com/i.test(u)), true);
});
