'use strict';

const { execFile, spawn } = require('node:child_process');
const { request } = require('undici');

let wslHolderChild = null;

/**
 * Mantém uma referência de sessão `wsl.exe` invisível aberta no Windows para impedir
 * que o `wslservice.exe` encerre a distro Linux 8 segundos após comandos curtos,
 * o que derrubaria o `ollama.service` no meio do stream (`ECONNRESET` / `Invalid EOF state`).
 */
function ensureWslKeepAliveHolder() {
  if (process.platform !== 'win32') return;
  if (wslHolderChild && wslHolderChild.exitCode === null && !wslHolderChild.killed) return;
  try {
    const child = spawn('wsl.exe', ['-e', 'sleep', 'infinity'], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    });
    child.on('exit', () => {
      if (wslHolderChild === child) wslHolderChild = null;
    });
    child.on('error', () => {
      if (wslHolderChild === child) wslHolderChild = null;
    });
    if (child.stdin && typeof child.stdin.unref === 'function') {
      child.stdin.unref();
    }
    child.unref();
    wslHolderChild = child;
  } catch (_) {
    // Ignora caso wsl.exe não exista na máquina
  }
}

/**
 * Encerra o processo auxiliar `wsl.exe` (caso tenha sido spawnado) durante o
 * shutdown gracioso do servidor para evitar processos órfãos.
 */
function cleanupWslKeepAlive() {
  if (!wslHolderChild) return false;
  const child = wslHolderChild;
  wslHolderChild = null;
  try {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Acorda a VM do WSL2 / serviço Ollama automaticamente caso o Windows tenha
 * hibernado a instância por ociosidade (evitando erro `read ECONNRESET` no portproxy 11434).
 */
function tryWakeLocalOllama() {
  if (process.platform !== 'win32') return Promise.resolve();
  ensureWslKeepAliveHolder();
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-e', 'sh', '-c', 'systemctl is-active ollama >/dev/null 2>&1 || true'],
      { timeout: 6000, windowsHide: true },
      () => resolve()
    );
  });
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-latest';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'granite4.2-uncensored:latest';
const DEFAULT_OLLAMA_NUM_CTX = 32768;

const OLLAMA_MODELS_CACHE_TTL_MS = 30_000;
const REMOTE_LLM_HEADERS_TIMEOUT_MS = 30_000;
const REMOTE_LLM_BODY_TIMEOUT_MS = 90_000;

// Cache de modelos por função de request (evita vazamento entre mocks de testes)
let ollamaModelsCacheByRequester = new WeakMap();

function clearOllamaModelsCache() {
  ollamaModelsCacheByRequester = new WeakMap();
}

function getRequesterCacheMap(requestFn) {
  let map = ollamaModelsCacheByRequester.get(requestFn);
  if (!map) {
    map = new Map();
    ollamaModelsCacheByRequester.set(requestFn, map);
  }
  return map;
}

const SUPPORTED_TRANSLATION_LANGUAGES = {
  'pt-BR': 'Português do Brasil (pt-BR)',
  en: 'English (en-US)',
  es: 'Español (es)',
  de: 'Deutsch (de)',
  ja: '日本語 / Japanese (ja)',
  ko: '한국어 / Korean (ko)',
  zh: '简体中文 / Chinese (zh-CN)',
  ru: 'Русский / Russian (ru)',
  fr: 'Français (fr)'
};

const RESPONSE_PROFILES = Object.freeze({
  factual_short: Object.freeze({
    intent: 'factual_short',
    numPredict: 750,
    temperature: 0.1,
    wordTarget: '150–400 palavras',
    styleInstruction:
      'PERFIL FACTUAL DIRETO (150–400 palavras): Responda diretamente à pergunta logo na PRIMEIRA FRASE de forma objetiva, enxuta e escaneável. Use no máximo 1–2 parágrafos curtos ou uma lista objetiva com os fatos verificados. PROIBIDO escrever ensaios filosóficos, introduções genéricas, preenchimento retórico ("encher linguiça") ou clichês de IA (como "hiperconectividade", "sinfonia", "tabuleiro de xadrez", "tapeçaria", "no cenário atual").',
    userCue:
      'Responda diretamente na primeira frase em 150–400 palavras, de forma objetiva e escaneável, citando [n] imediatamente após cada afirmação factual suportada pelas fontes.'
  }),
  howto_tech: Object.freeze({
    intent: 'howto_tech',
    numPredict: 1200,
    temperature: 0.12,
    wordTarget: '300–700 palavras',
    styleInstruction:
      'PERFIL TÉCNICO / HOW-TO (300–700 palavras): Entregue uma resposta técnica estruturada e pragmática, priorizando comandos, configurações, APIs, código ou ferramentas concretas efetivamente presentes nas fontes. Organize com subtítulos objetivos (`##`) apenas quando agregarem clareza e evite texto genérico.',
    userCue:
      'Forneça uma resposta técnica pragmática (300–700 palavras) com comandos, configurações ou ferramentas concretas respaldadas pelas fontes [1]..[N], citando [n] em cada ponto factual.'
  }),
  breaking_news: Object.freeze({
    intent: 'breaking_news',
    numPredict: 1000,
    temperature: 0.1,
    wordTarget: '200–500 palavras',
    styleInstruction:
      'PERFIL NOTÍCIAS / EVENTOS RECENTES (200–500 palavras): Produza um resumo datado destacando APENAS os fatos confirmados pelas fontes recentes. Sinalize explicitamente a data ou janela temporal indicada em cada fonte e declare claramente se as fontes não trouxerem cobertura atualizada sobre o período solicitado.',
    userCue:
      'Produza um resumo datado e factual (200–500 palavras) destacando apenas fatos confirmados pelas fontes recentes [1]..[N], indicando explicitamente datas/recência e eventuais lacunas.'
  }),
  deep_research: Object.freeze({
    intent: 'deep_research',
    numPredict: 1800,
    temperature: 0.15,
    wordTarget: '600–1200 palavras',
    styleInstruction:
      'PERFIL PESQUISA PROFUNDA / ARQUITETURAL (600–1200 palavras): Comece com uma síntese executiva densa respondendo à pergunta e desenvolva subseções analíticas específicas do tema (`##`) comparando mecanismos, trade-offs, evidências empíricas e tabelas comparativas Markdown quando respaldadas pelas fontes. Sem enchimento retórico.',
    userCue:
      'Elabore uma síntese técnica profunda e bem estruturada utilizando exclusivamente os fatos verificados nas fontes [1]..[N], comparando evidências e trade-offs com citações inline [n].'
  })
});

function stripDiacritics(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Classifica o perfil ideal de resposta (intenção, orçamento de tokens e estilo editorial)
 * a partir da pergunta do usuário, do `focusMode` e de um `intent` opcional explícito.
 */
function classifyResponseProfile(question = '', options = {}) {
  const opts = typeof options === 'string' ? { focusMode: options } : (options || {});
  const explicitIntent = String(opts.intent || '').trim().toLowerCase();
  const focusMode = String(opts.focusMode || 'web').trim().toLowerCase();

  const rawQ = String(question || '').trim();
  const qNorm = stripDiacritics(rawQ).toLowerCase();
  const wordCount = qNorm.split(/\s+/).filter(Boolean).length;

  // Sinais inequívocos de consulta factual curta e direta (prevalecem sobre howto_tech genérico de busca)
  const factualPhraseRe =
    /\b(qual o software|qual e o|qual o site|qual o nome|qual a capital|qual a porta|qual a versao|site oficial|url oficial|concorrente do|concorrente da|alternativa ao|significado de|definicao de|vem instalado|vem no|vem na)\b/i;

  if (explicitIntent) {
    if (explicitIntent === 'factual_short' || explicitIntent === 'short' || explicitIntent === 'factual') {
      return RESPONSE_PROFILES.factual_short;
    }
    if (
      explicitIntent === 'howto_tech' ||
      explicitIntent === 'howto' ||
      explicitIntent === 'code' ||
      explicitIntent === 'secops'
    ) {
      if (explicitIntent === 'howto_tech' && factualPhraseRe.test(qNorm)) {
        return RESPONSE_PROFILES.factual_short;
      }
      return RESPONSE_PROFILES.howto_tech;
    }
    if (explicitIntent === 'breaking_news' || explicitIntent === 'news' || explicitIntent === 'recent') {
      return RESPONSE_PROFILES.breaking_news;
    }
    if (
      explicitIntent === 'deep_research' ||
      explicitIntent === 'deep' ||
      explicitIntent === 'research' ||
      explicitIntent === 'academic'
    ) {
      return RESPONSE_PROFILES.deep_research;
    }
  }

  // 1. Sinais explícitos de análise profunda / arquitetura / comparação
  const deepResearchRe =
    /\b(analise profunda|analise detalhada|analise comparativa|deep research|deep dive|arquitetura|architecture|compare|comparar|comparativo|comparacao|diferenca entre|diferencas entre|versus|vs\.?|trade-?offs?|geopolitica|panorama global|evolucao historica|estado da arte|state of the art|benchmark|estudo detalhado|em detalhes|aprofundad[ao]|mecanismos internos|explique detalhadamente|vantagens e desvantagens|pros e contras)\b/i;

  // 2. Sinais de notícias / fatos recentes / temporalidade imediata
  const breakingNewsRe =
    /\b(hoje|agora|ultimas|ultimos|2026|atual|atualmente|recentes?|nesta semana|neste mes|nesse mes|breaking|latest|today|right now|current news|noticias?|aconteceu hoje|tocou hoje|acabou de)\b/i;

  // 3. Sinais técnicos de how-to / implementação / secops / troubleshooting
  const howtoTechRe =
    /\b(como configurar|como instalar|como implementar|como corrigir|como usar|como criar|como fazer deploy|como debugar|como resolver|como mitigar|como proteger|how to|tutorial|passo a passo|step by step|comandos?|cli|dockerfile|docker-compose|nginx|systemd|iptables|opnsense|kubernetes|k8s|cve-\d+|exploit|hardening|pentest|debug|troubleshoot|stack trace|exemplo de codigo|hook|syscalls?|ftrace|reverse proxy)\b/i;

  // 4. Sinais de consulta factual curta e direta
  const factualStartRe =
    /^(qual|quais|o que e|o que sao|quem|quando|onde|quanto|quantos|quantas|existe|what is|what are|who is|who was|when did|when was|where is|which|is there|does|que es|quien es|cuando|donde)\b/i;

  if (deepResearchRe.test(qNorm)) {
    return RESPONSE_PROFILES.deep_research;
  }

  if (breakingNewsRe.test(qNorm)) {
    return RESPONSE_PROFILES.breaking_news;
  }

  if (focusMode === 'code' || focusMode === 'secops' || howtoTechRe.test(qNorm)) {
    return RESPONSE_PROFILES.howto_tech;
  }

  if (focusMode === 'academic') {
    return RESPONSE_PROFILES.deep_research;
  }

  if (factualStartRe.test(qNorm) || factualPhraseRe.test(qNorm)) {
    return RESPONSE_PROFILES.factual_short;
  }

  if (wordCount > 0 && wordCount <= 8) {
    return RESPONSE_PROFILES.factual_short;
  }

  return RESPONSE_PROFILES.deep_research;
}

/**
 * Estima a contagem de tokens de um texto diferenciando scripts não-latinos
 * (CJK / Cirílico / Coreano / Árabe ~1.2 tok/char) de texto latino (~0.35 tok/char).
 */
function estimateTokenCount(text) {
  const str = String(text || '');
  if (!str) return 0;
  let nonLatinCount = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Cirílico (0400-04FF), Árabe/Hebraico (0590-06FF), Devanagari/Thai (0900-0E7F), CJK/Kana/Hangul (3000-D7AF, F900-FAFF)
    if (
      (code >= 0x0400 && code <= 0x04ff) ||
      (code >= 0x0590 && code <= 0x06ff) ||
      (code >= 0x0900 && code <= 0x0e7f) ||
      (code >= 0x3000 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      nonLatinCount += 1;
    }
  }
  const latinCount = str.length - nonLatinCount;
  return Math.ceil(nonLatinCount * 1.2 + latinCount * 0.35);
}

/**
 * Trunca um texto para caber aproximadamente dentro de `maxTokens` respeitando
 * a densidade de tokens de scripts não-latinos vs latinos e limites de palavra.
 */
function truncateToTokenBudget(text, maxTokens) {
  const str = String(text || '');
  if (!str || maxTokens <= 0) return '';
  const currentTokens = estimateTokenCount(str);
  if (currentTokens <= maxTokens) return str;

  const avgTokPerChar = currentTokens / str.length;
  let targetChars = Math.max(40, Math.floor((maxTokens - 4) / Math.max(0.35, avgTokPerChar)));
  if (targetChars >= str.length) return str;

  // Ajuste fino para garantir que o corte fique estritamente <= maxTokens
  let slice = str.slice(0, targetChars);
  while (slice.length > 40 && estimateTokenCount(slice) > maxTokens) {
    targetChars = Math.floor(targetChars * 0.88);
    slice = str.slice(0, Math.max(40, targetChars));
  }

  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > slice.length * 0.7) {
    slice = slice.slice(0, lastSpace);
  }
  return `${slice.trimEnd()}…`;
}

/**
 * Ajusta os trechos das fontes para que o contexto total nunca ultrapasse ~65%
 * da janela `numCtx`, preservando todos os índices [1..N] sem mutar os objetos originais.
 */
function fitSourcesToTokenBudget(sources = [], numCtx = DEFAULT_OLLAMA_NUM_CTX) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const safeNumCtx = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0 ? Number(numCtx) : DEFAULT_OLLAMA_NUM_CTX;
  const maxContextTokens = Math.floor(safeNumCtx * 0.65);
  const promptOverheadTokens = 450;
  const availableTokens = Math.max(512, maxContextTokens - promptOverheadTokens);

  const perSourceOverhead = 45;
  const totalEstimated = sources.reduce((sum, src) => {
    const metaTokens = estimateTokenCount(`${src?.title || ''} ${src?.url || ''} ${src?.domain || ''}`);
    const excerptTokens = estimateTokenCount(src?.excerpt || '');
    return sum + perSourceOverhead + metaTokens + excerptTokens;
  }, 0);

  if (totalEstimated <= availableTokens) {
    return sources;
  }

  const totalMetaOverhead = sources.reduce((sum, src) => {
    return sum + perSourceOverhead + estimateTokenCount(`${src?.title || ''} ${src?.url || ''} ${src?.domain || ''}`);
  }, 0);
  const excerptPoolTokens = Math.max(sources.length * 60, availableTokens - totalMetaOverhead);
  const equalShare = Math.floor(excerptPoolTokens / sources.length);

  // Primeira passagem: calcula sobra de fontes mais curtas para redistribuir às maiores
  const excerptCosts = sources.map((src) => estimateTokenCount(src?.excerpt || ''));
  let surplus = 0;
  let overBudgetCount = 0;
  for (const cost of excerptCosts) {
    if (cost <= equalShare) {
      surplus += equalShare - cost;
    } else {
      overBudgetCount += 1;
    }
  }
  const perLargeBudget = overBudgetCount > 0 ? equalShare + Math.floor(surplus / overBudgetCount) : equalShare;

  return sources.map((src, idx) => {
    const cost = excerptCosts[idx];
    if (cost <= perLargeBudget) {
      return src;
    }
    return {
      ...src,
      excerpt: truncateToTokenBudget(src?.excerpt || '', perLargeBudget)
    };
  });
}

/**
 * Resolve qual provedor e modelo de LLM utilizar com base nas variáveis do .env
 * e no modelo selecionado dinamicamente na interface (`selectedModel`).
 */
function resolveLlmConfig(env = process.env, selectedModel = '') {
  const explicitProvider = String(env.LLM_PROVIDER || '').trim().toLowerCase();
  const anthropicKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const openaiKey = String(env.OPENAI_API_KEY || '').trim();
  const ollamaBaseUrl = String(env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, '');
  const ollamaModel = String(env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim();
  const ollamaNumCtx = Number(env.OLLAMA_NUM_CTX || DEFAULT_OLLAMA_NUM_CTX);

  const hasValidAnthropic = Boolean(anthropicKey && anthropicKey !== 'sua_chave_anthropic_aqui');
  const hasValidOpenai = Boolean(openaiKey && openaiKey !== 'sua_chave_openai_aqui');
  const cleanSelected = String(selectedModel || '').trim();

  if (cleanSelected) {
    if (cleanSelected.startsWith('claude-') && hasValidAnthropic) {
      return {
        provider: 'anthropic',
        apiKey: anthropicKey,
        model: cleanSelected
      };
    }
    if ((cleanSelected.startsWith('gpt-') || cleanSelected.startsWith('o1-') || cleanSelected.startsWith('o3-')) && hasValidOpenai) {
      return {
        provider: 'openai',
        apiKey: openaiKey,
        model: cleanSelected
      };
    }
    return {
      provider: 'ollama',
      apiKey: 'local-ollama',
      baseUrl: ollamaBaseUrl,
      model: cleanSelected,
      numCtx: ollamaNumCtx
    };
  }

  if (explicitProvider === 'ollama') {
    return {
      provider: 'ollama',
      apiKey: 'local-ollama',
      baseUrl: ollamaBaseUrl,
      model: ollamaModel,
      numCtx: ollamaNumCtx
    };
  }

  if (explicitProvider === 'openai' && hasValidOpenai) {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      model: String(env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim()
    };
  }

  if (explicitProvider === 'anthropic' && hasValidAnthropic) {
    return {
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: String(env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL).trim()
    };
  }

  if (hasValidAnthropic) {
    return {
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: String(env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL).trim()
    };
  }

  if (hasValidOpenai) {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      model: String(env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim()
    };
  }

  if (!explicitProvider) {
    return {
      provider: 'ollama',
      apiKey: 'local-ollama',
      baseUrl: ollamaBaseUrl,
      model: ollamaModel,
      numCtx: ollamaNumCtx
    };
  }

  return {
    provider: explicitProvider,
    apiKey: '',
    model: explicitProvider === 'openai'
      ? String(env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim()
      : String(env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL).trim()
  };
}

/**
 * Consulta a API local do Ollama (`GET /api/tags`) via undici para listar os modelos
 * instalados e permitir seleção dinâmica na interface, com cache TTL de 30 segundos.
 */
async function listOllamaModels({ env = process.env, requestFn = request, forceRefresh = false } = {}) {
  if (requestFn === request) {
    ensureWslKeepAliveHolder();
  }
  const baseUrl = String(env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, '');
  const defaultModel = String(env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim();
  const cacheKey = `${baseUrl}|${defaultModel}`;
  const cacheMap = getRequesterCacheMap(requestFn);
  const now = Date.now();

  if (!forceRefresh) {
    const cached = cacheMap.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.models.map((m) => ({ ...m }));
    }
  }

  try {
    const response = await requestFn(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      headersTimeout: 2500,
      bodyTimeout: 2500
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response?.body && typeof response.body.dump === 'function') {
        await response.body.dump().catch(() => {});
      }
      return [{ name: defaultModel, sizeGb: null, provider: 'ollama' }];
    }

    const data = await response.body.json();
    const rawModels = Array.isArray(data?.models) ? data.models : [];

    const filtered = rawModels
      .filter((m) => m && typeof m.name === 'string')
      // Ignora modelos puros de embedding (como bge-m3 ou nomic-embed) no seletor de geração
      .filter((m) => !/embed|bge-m3|minilm/i.test(m.name))
      .map((m) => ({
        name: m.name,
        sizeGb: m.size && m.size > 1000000 ? (Number(m.size) / (1024 ** 3)).toFixed(1) : 'Cloud',
        provider: 'ollama'
      }));

    if (filtered.length === 0) {
      return [{ name: defaultModel, sizeGb: null, provider: 'ollama' }];
    }

    const priorityOrder = [
      defaultModel,
      'eriktonon/deepseek-v4.1-flash-1017:9b',
      'eriktonon/qwen3.8-uncensored:9b',
      'eriktonon/granite4.2-uncensored:8b',
      'eriktonon/granite4.2-uncensored:latest',
      'granite4.2-uncensored:latest'
    ];

    filtered.sort((a, b) => {
      const idxA = priorityOrder.indexOf(a.name);
      const idxB = priorityOrder.indexOf(b.name);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    cacheMap.set(cacheKey, {
      models: filtered.map((m) => ({ ...m })),
      expiresAt: Date.now() + OLLAMA_MODELS_CACHE_TTL_MS
    });

    return filtered;
  } catch (_) {
    if (requestFn === request) {
      tryWakeLocalOllama().catch(() => {});
    }
    return [{ name: defaultModel, sizeGb: null, provider: 'ollama' }];
  }
}

function resolveProfileArg(profileOrOptions, question = '') {
  if (profileOrOptions && typeof profileOrOptions === 'object' && profileOrOptions.styleInstruction) {
    return profileOrOptions;
  }
  if (profileOrOptions && typeof profileOrOptions === 'object') {
    return classifyResponseProfile(profileOrOptions.question || question, profileOrOptions);
  }
  if (typeof profileOrOptions === 'string' && profileOrOptions) {
    return classifyResponseProfile(question, { intent: profileOrOptions });
  }
  if (question) {
    return classifyResponseProfile(question);
  }
  return RESPONSE_PROFILES.deep_research;
}

/**
 * Gera a instrução de sistema calibrada com regra inegociável de abstinência,
 * anti-alucinação, controle adaptativo de verbosidade e citações estritas [1]..[N].
 */
function buildSystemPrompt(validSourceCount, searchLang = '', profileOrOptions = null) {
  if (validSourceCount <= 0) {
    return [
      'Você é o DeepEvil, um mecanismo de pesquisa global (Worldwide Research Engine) factual e rigoroso.',
      'Nenhuma página web pôde ser extraída com sucesso para esta consulta.',
      'Informe claramente ao usuário que não foi possível obter trechos legíveis das fontes para fundamentar a resposta e NUNCA invente citações como [1].'
    ].join(' ');
  }

  const targetLangLabel = searchLang && SUPPORTED_TRANSLATION_LANGUAGES[searchLang]
    ? SUPPORTED_TRANSLATION_LANGUAGES[searchLang]
    : 'o MESMO IDIOMA da pergunta do usuário';

  const profile = resolveProfileArg(profileOrOptions);

  return [
    'Você é o DeepEvil, um mecanismo de pesquisa global (Worldwide Research Engine) multidisciplinar, factual e calibrado contra alucinações.',
    'REGRAS OBRIGATÓRIAS DE GROUNDING, ABSTINÊNCIA E SÍNTESE:',
    '1. REGRA INEGOCIÁVEL DE ABSTINÊNCIA E CALIBRAÇÃO DE INCERTEZA (ANTI-ALUCINAÇÃO): SE AS FONTES FORNECIDAS NÃO CONTIVEREM A RESPOSTA EXATA PARA A PERGUNTA DO USUÁRIO, DECLARE EXPLICITAMENTE O QUE NÃO FOI ENCONTRADO NAS FONTES em vez de extrapolar, preencher lacunas ou atribuir fatos inventados a [n]. NUNCA atribua [n] a uma afirmação que não esteja literalmente suportada pelo trecho [n].',
    '2. FOCO DIRETO E COERÊNCIA 100% COM O DOMÍNIO DA PERGUNTA ATUAL: Responda exatamente ao que o usuário perguntou adaptando o vocabulário estritamente ao domínio do tema pesquisado. NUNCA introduza jargões de software, IA ou computação se a pergunta for sobre outro domínio. PROIBIDO usar frases de "encher linguiça", floreios filosóficos ou clichês de IA ("hiperconectividade", "sinfonia", "tabuleiro de xadrez").',
    `3. SÍNTESE MULTI-POLAR GLOBAL (-> ${targetLangLabel}): Os trechos numerados [1]..[N] podem vir de múltiplos idiomas e polos globais. Traduza e integre apenas os fatos efetivamente presentes nesses trechos diretamente para ${targetLangLabel}.`,
    '4. ISOLAMENTO ESTRITO DAS FONTES ATUAIS (ZERO AUTO-REFERÊNCIA): Baseie 100% dos fatos, dados, datas e números exclusivamente nos trechos [1]..[N] fornecidos NESTE turno. JAMAIS misture fatos ou índices de citações de turnos anteriores e NUNCA cite "Erik Tonon" ou o próprio motor como fonte externa.',
    '5. CITAÇÕES INLINE OBRIGATÓRIAS: Toda afirmação factual importante DEVE trazer sua citação imediatamente após a afirmação usando estritamente colchetes individuais, como [1] ou [1][2]. Nunca agrupe com vírgula como [1, 2] e nunca envolva em itálico/parênteses como ([1]).',
    `6. INTERVALO VÁLIDO DE CITAÇÃO: Cite APENAS números entre [1] e [${validSourceCount}]. Nunca cite uma fonte fora desse intervalo.`,
    `7. ${profile.styleInstruction}`,
    `8. IDIOMA NATIVO E VOCABULÁRIO PRECISO: Redija 100% da resposta em ${targetLangLabel} com ortografia e terminologia precisas.`
  ].join('\n');
}

/**
 * Extrai entidades principais (termos em negrito, siglas e nomes próprios) de um texto
 * de resposta anterior já livre de marcadores de citação [n].
 */
function extractPriorEntities(rawMarkdown = '') {
  const withoutCitations = String(rawMarkdown || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '');

  const seen = new Set();
  const entities = [];
  const addEntity = (candidate) => {
    const clean = String(candidate || '').replace(/[`*_#[\]()]/g, '').trim();
    if (clean.length < 2 || clean.length > 48) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entities.push(clean);
  };

  // 1. Termos em negrito (**Entidade**)
  for (const m of withoutCitations.matchAll(/\*\*([^*\n]{2,45})\*\*/g)) {
    addEntity(m[1]);
    if (entities.length >= 6) return entities;
  }

  // 2. Identificadores em código inline (`ident`)
  for (const m of withoutCitations.matchAll(/`([^`\n]{2,40})`/g)) {
    addEntity(m[1]);
    if (entities.length >= 6) return entities;
  }

  // 3. Siglas (2-10 letras maiúsculas/dígitos/hífen) e nomes próprios compostos
  for (const m of withoutCitations.matchAll(/\b([A-Z][A-Z0-9-]{1,12}|[A-Z][a-z]+(?:\s+[A-Z][a-z0-9.-]+){1,2})\b/g)) {
    addEntity(m[1]);
    if (entities.length >= 6) return entities;
  }

  return entities;
}

/**
 * Resume turnos anteriores (pergunta + resumo enxuto de até 280 chars + entidades principais)
 * para resolver follow-ups anafóricos ("qual deles suporta API OpenAI?"), removendo
 * estritamente todos os marcadores [n] para impedir vazamento de índices entre turnos.
 */
function summarizePriorTurnContext(priorTurns = []) {
  if (!Array.isArray(priorTurns) || priorTurns.length === 0) return '';
  const recent = priorTurns
    .filter((t) => t && t.question)
    .slice(-2)
    .map((t, idx) => {
      const lines = [`- Pergunta anterior ${idx + 1}: "${String(t.question).trim()}"`];
      const rawAns = String(t.answer_markdown || t.answer || '').trim();
      if (rawAns) {
        const cleanAns = rawAns
          .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
          .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
          .replace(/```[\s\S]*?```/g, ' ')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/[*_`~|>]/g, '')
          .replace(/\s+([.,;:!?])/g, '$1')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleanAns) {
          let snippet = cleanAns;
          if (snippet.length > 280) {
            const cut = snippet.slice(0, 280);
            const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
            snippet = `${(lastBreak > 180 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
          }
          lines.push(`  Resumo anterior (sem citações): ${snippet}`);
        }
        const entities = extractPriorEntities(rawAns);
        if (entities.length > 0) {
          lines.push(`  Entidades mencionadas: ${entities.join(', ')}`);
        }
      }
      return lines.join('\n');
    });

  if (recent.length === 0) return '';
  return [
    'CONTEXTO DE NAVEGAÇÃO DA CONVERSA (Use APENAS para resolver referências anafóricas como "disso", "ele", "qual deles" ou "nesse caso"; NUNCA repita tópicos anteriores nem reaproveite números de citação de turnos passados):',
    ...recent,
    ''
  ].join('\n');
}

/**
 * Monta o prompt do turno atual com os trechos legíveis numerados [1]..[N] ajustados
 * ao orçamento de tokens e calibrados ao perfil de resposta.
 */
function buildUserPromptWithExcerpts(question, sources = [], priorTurns = [], searchLang = '', profileOrOptions = null) {
  if (!sources || sources.length === 0) {
    return [
      'Nenhuma página pôde ser obtida e extraída com sucesso para esta pergunta.',
      '',
      `Pergunta: ${String(question || '').trim()}`,
      '',
      'Explique que nenhuma fonte pôde ser extraída com sucesso nesta tentativa e não inclua nenhuma citação [n].'
    ].join('\n');
  }

  const profile = resolveProfileArg(profileOrOptions, question);
  const numCtx = profileOrOptions && typeof profileOrOptions === 'object' && profileOrOptions.numCtx
    ? profileOrOptions.numCtx
    : DEFAULT_OLLAMA_NUM_CTX;
  const budgetedSources = fitSourcesToTokenBudget(sources, numCtx);

  const formattedExcerpts = budgetedSources
    .map((src, idx) => {
      const cIdx = src.citationIndex ?? idx + 1;
      return [
        `[${cIdx}] Título: ${src.title}`,
        `URL: ${src.url}`,
        `Domínio: ${src.domain}`,
        'Trecho Extraído:',
        '"""',
        src.excerpt,
        '"""'
      ].join('\n');
    })
    .join('\n\n---\n\n');

  const priorContextBlock = summarizePriorTurnContext(priorTurns);
  const langInstruction = searchLang && SUPPORTED_TRANSLATION_LANGUAGES[searchLang]
    ? `em ${SUPPORTED_TRANSLATION_LANGUAGES[searchLang]}`
    : 'no idioma da pergunta do usuário';

  return [
    priorContextBlock,
    'FONTES EXTRAÍDAS COM SUCESSO PARA ESTE TURNO:',
    '',
    formattedExcerpts,
    '',
    '============================================================',
    `PERGUNTA ATUAL DO USUÁRIO: ${String(question || '').trim()}`,
    '',
    `Instrução Crítica (${profile.intent} · ${langInstruction}): ${profile.userCue} Utilize exclusivamente fatos literalmente presentes nas fontes [1] a [${budgetedSources.length}]. Se alguma parte da pergunta não estiver respondida nas fontes, declare explicitamente o que não foi encontrado sem extrapolar.`
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Constrói a mensagem de prompt isolando as citações [1]..[N] do turno atual para
 * evitar contaminação de índices [1][2] e repetição de vocabulário de turnos passados.
 */
function buildConversationMessages(priorTurns = [], currentQuestion = '', currentSources = [], searchLang = '', profileOrOptions = null) {
  return [
    {
      role: 'user',
      content: buildUserPromptWithExcerpts(currentQuestion, currentSources, priorTurns, searchLang, profileOrOptions)
    }
  ];
}

/**
 * Sanitização leve de citações usada incrementalmente em janelas curtas durante o streaming.
 */
function sanitizeCitationsLight(chunkText, maxCitationIndex) {
  const text = String(chunkText || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/\s*\[Trecho:[^\]]*\]/gi, '');

  if (maxCitationIndex <= 0) {
    return text
      .replace(/\*+\[\d+(?:\s*,\s*\d+)*\]\*+/g, '')
      .replace(/\(\[\d+(?:\s*,\s*\d+)*\]\)/g, '')
      .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '');
  }

  // 1. Expande listas [1, 2] -> [1][2] antes de remover wrappers *[...]* / ([...])
  const expanded = text
    .replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, listStr) => {
      return listStr
        .split(',')
        .map((part) => `[${part.trim()}]`)
        .join('');
    })
    .replace(/\*+((?:\[\d+\])+)\*+/g, '$1')
    .replace(/\(((?:\[\d+\])+)\)/g, '$1');

  // 2. Mantém apenas [n] onde 1 <= n <= maxCitationIndex
  return expanded.replace(/\[(\d+)\]/g, (_full, numStr) => {
    const n = Number(numStr);
    if (Number.isInteger(n) && n >= 1 && n <= maxCitationIndex) {
      return `[${n}]`;
    }
    return '';
  });
}

/**
 * Normaliza citações combinadas (ex: "[1, 2]" -> "[1][2]"), corrige eventuais artefatos
 * de tokenização no passo final e remove qualquer citação cujo índice não pertença ao
 * conjunto [1..maxCitationIndex] de páginas efetivamente obtidas com sucesso.
 */
function sanitizeCitations(markdownText, maxCitationIndex) {
  const cleaned = String(markdownText || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/\bConcórvora\b/gi, 'Concorrência')
    .replace(/\bconcórvora\b/g, 'concorrência')
    .replace(/\bMotorres\b/g, 'Motores')
    .replace(/\bmotorres\b/g, 'motores')
    .replace(/\bDescobta\b/g, 'Descoberta')
    .replace(/\bdescobta\b/g, 'descoberta')
    .replace(/\bTécnnicos\b/g, 'Técnicos')
    .replace(/\btécnnicos\b/g, 'técnicos')
    .replace(/\s+(?:de|por|by)\s+Erik\s+Tonon\b/gi, '');

  return sanitizeCitationsLight(cleaned, maxCitationIndex);
}

/**
 * Sanitizador incremental O(N) para streaming token-a-token:
 * evita re-executar regexes globais em todo o buffer acumulado a cada token (que era O(N^2)),
 * aplicando sanitização leve apenas na cauda ativa (~120 chars / quebras de sentença/parágrafo)
 * e garantindo sanitização completa no passo `finalize()`.
 */
function createIncrementalCitationSanitizer(maxCitationIndex) {
  const rawChunks = [];
  let committedClean = '';
  let pendingRaw = '';
  let inThinkBlock = false;
  let thinkTail = '';
  let lastLightView = '';
  let charsSinceSanitize = 0;

  const findSafeSplitIndex = (buf) => {
    // Nunca quebra no meio de um marcador aberto `[`, `(`, `*` ou `<`
    let limit = buf.length;
    const openBracket = buf.lastIndexOf('[');
    const closeBracket = buf.lastIndexOf(']');
    if (openBracket > closeBracket) {
      limit = Math.min(limit, openBracket);
    }
    const openAngle = buf.lastIndexOf('<');
    const closeAngle = buf.lastIndexOf('>');
    if (openAngle > closeAngle) {
      limit = Math.min(limit, openAngle);
    }
    const openParen = buf.lastIndexOf('(');
    const closeParen = buf.lastIndexOf(')');
    if (openParen > closeParen && openParen >= buf.length - 16) {
      limit = Math.min(limit, openParen);
    }
    const lastStar = buf.lastIndexOf('*');
    if (lastStar >= buf.length - 4) {
      limit = Math.min(limit, lastStar);
    }

    if (limit <= 0) return 0;

    // Prefere quebra de parágrafo ou fim de sentença; senão último espaço seguro
    const candidate = buf.slice(0, limit);
    const lastNewline = candidate.lastIndexOf('\n');
    if (lastNewline >= 24) return lastNewline + 1;

    const sentenceBreakMatch = candidate.match(/^([\s\S]*?[.!?]\s+)(?=[^\s])/);
    if (sentenceBreakMatch && sentenceBreakMatch[1].length >= 24) {
      const idx = candidate.lastIndexOf('. ');
      if (idx >= 24) return idx + 2;
    }

    const lastSpace = candidate.lastIndexOf(' ');
    if (lastSpace >= 24) return lastSpace + 1;
    return 0;
  };

  return {
    push(delta) {
      if (!delta) return lastLightView;
      rawChunks.push(delta);

      let incoming = delta;

      // Descarta blocos <think>...</think> em O(1) de memória/tempo por token
      if (inThinkBlock) {
        const combined = thinkTail + incoming;
        const closeMatch = /<\/think>\s*/i.exec(combined);
        if (!closeMatch) {
          thinkTail = combined.slice(-16);
          return lastLightView;
        }
        inThinkBlock = false;
        thinkTail = '';
        incoming = combined.slice(closeMatch.index + closeMatch[0].length);
        if (!incoming) return lastLightView;
      }

      pendingRaw += incoming;
      charsSinceSanitize += incoming.length;

      // Verifica abertura de <think> na janela pendente
      const openThinkMatch = /<think>/i.exec(pendingRaw);
      if (openThinkMatch) {
        const beforeThink = pendingRaw.slice(0, openThinkMatch.index);
        if (beforeThink) {
          committedClean += sanitizeCitationsLight(beforeThink, maxCitationIndex);
        }
        const afterThinkStart = pendingRaw.slice(openThinkMatch.index + openThinkMatch[0].length);
        const closeThinkMatch = /<\/think>\s*/i.exec(afterThinkStart);
        if (closeThinkMatch) {
          pendingRaw = afterThinkStart.slice(closeThinkMatch.index + closeThinkMatch[0].length);
        } else {
          inThinkBlock = true;
          thinkTail = afterThinkStart.slice(-16);
          pendingRaw = '';
          lastLightView = committedClean;
          return lastLightView;
        }
      }

      const hitBoundary =
        charsSinceSanitize >= 120 ||
        pendingRaw.length >= 160 ||
        /[\n.!?\]*)]/.test(incoming);

      if (pendingRaw.length >= 120 || /\n/.test(incoming)) {
        const splitIdx = findSafeSplitIndex(pendingRaw);
        if (splitIdx > 0) {
          committedClean += sanitizeCitationsLight(pendingRaw.slice(0, splitIdx), maxCitationIndex);
          pendingRaw = pendingRaw.slice(splitIdx);
          charsSinceSanitize = 0;
        }
      }

      if (hitBoundary || !lastLightView) {
        lastLightView = committedClean + sanitizeCitationsLight(pendingRaw, maxCitationIndex);
        if (charsSinceSanitize >= 120) charsSinceSanitize = 0;
      } else {
        // Anexa diretamente quando não há marcadores pendentes (evita regex por token)
        lastLightView = committedClean + pendingRaw;
      }

      return lastLightView;
    },

    finalize(trimOutput = false) {
      const fullRaw = rawChunks.join('');
      return sanitizeCitations(trimOutput ? fullRaw.trim() : fullRaw, maxCitationIndex);
    }
  };
}

const CITATION_STOPWORDS = new Set([
  // PT
  'para', 'como', 'mais', 'sobre', 'entre', 'pelo', 'pela', 'pelos', 'pelas', 'isso',
  'este', 'esta', 'estes', 'estas', 'esse', 'essa', 'esses', 'essas', 'aquele', 'aquela',
  'pode', 'podem', 'podendo', 'tambem', 'ainda', 'onde', 'quando', 'qual', 'quais', 'muito',
  'cada', 'apos', 'antes', 'depois', 'durante', 'segundo', 'acordo', 'fontes', 'fonte',
  'trecho', 'trechos', 'assim', 'entao', 'porem', 'contudo', 'todavia', 'portanto',
  'atraves', 'meio', 'forma', 'modo', 'outro', 'outra', 'outros', 'outras', 'todos', 'todas',
  'sendo', 'foram', 'eram', 'sera', 'serao', 'esta', 'estao', 'estava', 'tinha', 'possui',
  'permite', 'permitem', 'usando', 'utiliza', 'utilizam', 'utilizando', 'além', 'alem',
  'apenas', 'mesmo', 'mesma', 'diferentes', 'diversos', 'diversas', 'geralmente', 'principalmente',
  // EN
  'with', 'that', 'this', 'from', 'have', 'been', 'were', 'their', 'there', 'which',
  'about', 'into', 'more', 'also', 'such', 'than', 'then', 'they', 'them', 'when',
  'where', 'while', 'through', 'using', 'allows', 'provides', 'these', 'those', 'some',
  'many', 'most', 'very', 'only', 'just', 'over', 'under', 'after', 'before', 'during',
  'between', 'other', 'others', 'both', 'each', 'well', 'does', 'will', 'would', 'could',
  'should', 'being', 'used', 'based', 'according', 'source', 'sources',
  // ES
  'desde', 'hasta', 'pero', 'porque', 'donde', 'cuando', 'tambien', 'puede', 'pueden',
  'segun', 'entre', 'sobre', 'como', 'para', 'este', 'esta', 'estos', 'estas', 'otros', 'otras'
]);

const NON_LATIN_SCRIPT_RE = /[\u0400-\u04ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;

function isPredominantlyNonLatin(text) {
  const clean = String(text || '').replace(/\s+/g, '');
  if (clean.length < 12) return false;
  const matches = clean.match(NON_LATIN_SCRIPT_RE);
  return Boolean(matches && matches.length / clean.length >= 0.15);
}

/**
 * Extrai termos e âncoras significativas (siglas, números, nomes próprios, tokens >= 4 chars)
 * de uma sentença/cláusula para verificação determinística contra a fonte citada.
 */
function extractClaimFeatures(clauseText) {
  const clean = String(clauseText || '')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, ' ')
    .replace(/[`*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const anchors = [];
  const numbers = [];
  const terms = [];
  const seenAnchors = new Set();
  const seenNumbers = new Set();
  const seenTerms = new Set();

  const rawTokens = clean.match(/[\p{L}\p{N}][\p{L}\p{N}._:-]*/gu) || [];

  for (let i = 0; i < rawTokens.length; i++) {
    const raw = rawTokens[i].replace(/^[.:-]+|[.:-]+$/g, '');
    if (!raw) continue;
    const norm = stripDiacritics(raw).toLowerCase();

    // 1. Números significativos (anos, versões, métricas >= 2 dígitos ou com separador decimal/hífen)
    if (/^\d{2,}(?:[.,:-]\d+)?%?$/.test(raw) || /^\d+\.\d+/.test(raw)) {
      if (!seenNumbers.has(norm)) {
        seenNumbers.add(norm);
        numbers.push(norm);
      }
      if (!seenAnchors.has(norm)) {
        seenAnchors.add(norm);
        anchors.push(norm);
      }
      continue;
    }

    // 2. Siglas / identificadores técnicos (ALL-CAPS >= 2, snake_case, kebab com dígitos, camelCase)
    const isAcronym = /^[A-Z][A-Z0-9-]{1,14}$/.test(raw) && !/^(DE|DO|DA|EM|NO|NA|OS|AS|UM|OU|SE|AO|BY|IN|ON|OF|TO|OR|IS|IT|AS|AT|EL|LA|EN)$/.test(raw);
    const isTechIdent = /[_]/.test(raw) || /[a-z][A-Z]/.test(raw) || (/[A-Za-z]/.test(raw) && /\d/.test(raw));
    const isProperNoun = i > 0 && /^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][a-záàâãéêíóôõúç]{2,}/.test(raw) && !CITATION_STOPWORDS.has(norm);

    if (isAcronym || isTechIdent || isProperNoun) {
      if (!seenAnchors.has(norm)) {
        seenAnchors.add(norm);
        anchors.push(norm);
      }
    }

    // 3. Termos gerais significativos (>= 4 chars fora de stopwords)
    if (norm.length >= 4 && !CITATION_STOPWORDS.has(norm) && !/^\d+$/.test(norm)) {
      if (!seenTerms.has(norm)) {
        seenTerms.add(norm);
        terms.push(norm);
      }
    }
  }

  return { anchors, numbers, terms, clean };
}

function sourceMatchesAcronymExpansion(acronym, sourceRaw) {
  if (!/^[a-z]{2,6}$/.test(acronym)) return false;
  const words = stripDiacritics(sourceRaw)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length < acronym.length) return false;
  for (let i = 0; i <= words.length - acronym.length; i++) {
    let ok = true;
    for (let j = 0; j < acronym.length; j++) {
      if (words[i + j][0] !== acronym[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function tokenMatchesSource(token, sourceNorm, sourceTokenSet, sourceTokensList, sourceRaw) {
  if (!token) return 0;
  if (sourceTokenSet.has(token)) return 1.0;

  // Substring direta para identificadores compostos (ex: syscalls vs sys_call_table, bge-m3)
  if (token.length >= 4 && sourceNorm.includes(token)) return 1.0;
  if (token.includes('_') || token.includes('-')) {
    const compact = token.replace(/[_-]/g, '');
    if (compact.length >= 4 && sourceNorm.replace(/[_-]/g, '').includes(compact)) return 1.0;
  }
  if (token.length >= 5 && sourceNorm.replace(/[_-]/g, '').includes(token)) return 0.9;

  // Expansão de sigla (ex: SSE -> Server-Sent Events)
  if (token.length >= 2 && token.length <= 6 && sourceMatchesAcronymExpansion(token, sourceRaw)) {
    return 0.9;
  }

  // Stem/prefixo para cognatos cross-lingual PT/EN/ES/DE/FR (ex: concorrencia/concurrency, isolamento/isolation)
  if (token.length >= 5) {
    const stem5 = token.slice(0, 5);
    for (const st of sourceTokensList) {
      if (st.length >= 5 && st.startsWith(stem5)) return 0.75;
    }
    const stem4 = token.slice(0, 4);
    for (const st of sourceTokensList) {
      if (st.length >= 5 && st.startsWith(stem4) && Math.abs(st.length - token.length) <= 4) {
        return 0.6;
      }
    }
  }

  return 0;
}

/**
 * Verificador determinístico pós-geração de grounding de citações inline `[n]`.
 * Analisa cada sentença/cláusula com `[n]` e compara termos/entidades significativas
 * contra `sources[n-1].title + sources[n-1].excerpt` (com suporte cross-lingual).
 *
 * @returns {{ totalCitations: number, verifiedCitations: number, unverifiedCitations: number, faithfulnessScore: number, warnings: string[] }}
 */
function verifyCitationGrounding(markdown, sources = []) {
  const text = String(markdown || '').trim();
  const srcList = Array.isArray(sources) ? sources : [];
  const warnings = [];

  if (!text) {
    return {
      totalCitations: 0,
      verifiedCitations: 0,
      unverifiedCitations: 0,
      faithfulnessScore: 1,
      warnings
    };
  }

  // Mapa índice [1..N] -> fonte + índices pré-processados para busca O(1)/rápida
  const sourceIndexMap = new Map();
  srcList.forEach((src, idx) => {
    if (!src) return;
    const cIdx = Number.isInteger(Number(src.citationIndex)) && Number(src.citationIndex) > 0
      ? Number(src.citationIndex)
      : idx + 1;
    const combinedRaw = [
      src.title || '',
      src.originalTitle || '',
      src.domain || '',
      src.siteName || '',
      src.excerpt || ''
    ].join(' ');
    const norm = stripDiacritics(combinedRaw).toLowerCase();
    const tokensList = norm.match(/[\p{L}\p{N}][\p{L}\p{N}._:-]*/gu) || [];
    const tokenSet = new Set(tokensList);
    const nonLatin = isPredominantlyNonLatin(combinedRaw);
    const latinAnchorCount = nonLatin
      ? tokensList.filter((t) => /^[a-z0-9][a-z0-9._-]{1,}$/.test(t) && !/^(org|com|net|www|http|https|wikipedia|wiki)$/.test(t)).length
      : 0;
    sourceIndexMap.set(cIdx, {
      citationIndex: cIdx,
      raw: combinedRaw,
      norm,
      tokensList,
      tokenSet,
      nonLatin,
      latinAnchorCount,
      title: String(src.title || src.domain || `Fonte ${cIdx}`)
    });
  });

  // Divide markdown em linhas/sentenças preservando URLs e números decimais
  const segments = text
    .split(/\r?\n+/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || /^\|?\s*:?-{3,}/.test(trimmed)) return [];
      return trimmed.split(/(?<=[.!?。！？])\s+(?=[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ0-9*"'`(-])/).filter(Boolean);
    });

  let totalCitations = 0;
  let verifiedCitations = 0;
  let unverifiedCitations = 0;

  for (const sentence of segments) {
    const citationMatches = [...sentence.matchAll(/\[(\d+)\]/g)];
    if (citationMatches.length === 0) continue;

    // Agrupa citações adjacentes (ex: [1][2]) para avaliarem a mesma cláusula precedente
    let lastClauseStart = 0;
    let prevClauseText = '';

    for (let i = 0; i < citationMatches.length; i++) {
      const match = citationMatches[i];
      const n = Number(match[1]);
      const matchStart = match.index;
      const betweenText = sentence.slice(lastClauseStart, matchStart).trim();

      let clauseToCheck;
      if (betweenText.length >= 12) {
        clauseToCheck = betweenText;
        prevClauseText = betweenText;
      } else if (prevClauseText) {
        // Citação adjacente (ex: [1][2]) compartilha a cláusula imediatamente anterior
        clauseToCheck = prevClauseText;
      } else {
        clauseToCheck = sentence;
      }
      lastClauseStart = matchStart + match[0].length;

      totalCitations += 1;
      const srcInfo = sourceIndexMap.get(n);
      if (!srcInfo) {
        unverifiedCitations += 1;
        warnings.push(`Citação fora do intervalo [${n}] em: "${sentence.slice(0, 110)}"`);
        continue;
      }

      let features = extractClaimFeatures(clauseToCheck);
      // Se a cláusula local for muito curta (ex: célula de tabela ou trecho mínimo), amplia para a sentença
      if (features.anchors.length === 0 && features.terms.length === 0 && clauseToCheck !== sentence) {
        features = extractClaimFeatures(sentence);
      }

      const uniqueCheckTokens = new Set([...features.anchors, ...features.terms]);
      if (uniqueCheckTokens.size === 0) {
        verifiedCitations += 1;
        continue;
      }

      let matchedAnchors = 0;
      let matchedNumbers = 0;
      let matchedTerms = 0;
      let weightedHits = 0;
      let weightedTotal = 0;

      for (const num of features.numbers) {
        if (tokenMatchesSource(num, srcInfo.norm, srcInfo.tokenSet, srcInfo.tokensList, srcInfo.raw) > 0) {
          matchedNumbers += 1;
        }
      }

      const anchorSet = new Set(features.anchors);
      for (const anchor of features.anchors) {
        weightedTotal += 1.5;
        const score = tokenMatchesSource(anchor, srcInfo.norm, srcInfo.tokenSet, srcInfo.tokensList, srcInfo.raw);
        if (score > 0) {
          matchedAnchors += 1;
          weightedHits += 1.5 * score;
        }
      }

      for (const term of features.terms) {
        if (anchorSet.has(term)) continue;
        weightedTotal += 1.0;
        const score = tokenMatchesSource(term, srcInfo.norm, srcInfo.tokenSet, srcInfo.tokensList, srcInfo.raw);
        if (score > 0) {
          matchedTerms += 1;
          weightedHits += score;
        }
      }

      const overlapRatio = weightedTotal > 0 ? weightedHits / weightedTotal : 0;
      const totalMatched = matchedAnchors + matchedTerms;
      const hasUnbackedNumbers = features.numbers.length > 0 && matchedNumbers === 0;

      let verified = false;

      if (srcInfo.nonLatin && !isPredominantlyNonLatin(clauseToCheck)) {
        // Tolerância cross-script (ex: fonte em Chinês/Japonês/Coreano/Russo sintetizada em PT/EN):
        // - Se houver âncora/termo compartilhado e sem números contraditórios -> verificado;
        // - Se a fonte for puramente não-latina (sem âncoras latinas próprias) e a sentença não
        //   introduzir números/siglas/nomes próprios ausentes -> tolerância cross-script;
        // - Se a fonte tiver âncoras latinas próprias (ex: DeepSeek-V3, MoE, 671B) e a sentença
        //   não tiver NENHUM overlap -> sinaliza como não verificada.
        if (matchedAnchors >= 1 || matchedTerms >= 1) {
          verified = !hasUnbackedNumbers || matchedAnchors >= 2;
        } else if (srcInfo.latinAnchorCount < 2 && features.numbers.length === 0 && features.anchors.length === 0) {
          verified = true;
        } else {
          verified = false;
        }
      } else {
        // Mesmo alfabeto (PT/EN/ES/DE/FR): exige suporte verificável real
        if (hasUnbackedNumbers && overlapRatio < 0.45 && matchedTerms < 2) {
          verified = false;
        } else if (overlapRatio >= 0.3) {
          verified = true;
        } else if (matchedAnchors >= 2 && !hasUnbackedNumbers) {
          verified = true;
        } else if (matchedAnchors >= 1 && uniqueCheckTokens.size <= 5 && !hasUnbackedNumbers) {
          verified = true;
        } else if (totalMatched >= 2 && overlapRatio >= 0.2 && !hasUnbackedNumbers) {
          verified = true;
        }
      }

      if (verified) {
        verifiedCitations += 1;
      } else {
        unverifiedCitations += 1;
        warnings.push(
          `Citação [${n}] (${srcInfo.title.slice(0, 48)}) com baixo suporte textual (overlap=${overlapRatio.toFixed(2)}): "${clauseToCheck.slice(0, 110)}"`
        );
      }
    }
  }

  let faithfulnessScore;
  if (totalCitations === 0) {
    const isAbstention =
      /n[aã]o\s+(?:foi|foram)\s+(?:encontrad|poss[ií]vel)|fontes\s+fornecidas\s+n[aã]o|not\s+found\s+in\s+the\s+sources/i.test(
        text
      );
    if (srcList.length > 0 && text.length > 200 && !isAbstention) {
      faithfulnessScore = 0;
      warnings.push('Resposta extensa sem nenhuma citação inline [n] apesar de haver fontes verificadas.');
    } else {
      faithfulnessScore = 1;
    }
  } else {
    faithfulnessScore = Number((verifiedCitations / totalCitations).toFixed(3));
  }

  return {
    totalCitations,
    verifiedCitations,
    unverifiedCitations,
    faithfulnessScore,
    warnings
  };
}

/**
 * Realiza streaming da resposta do Ollama, Claude (Anthropic) ou GPT (OpenAI) via undici.
 * Chama `onDelta(deltaText, accumulatedSanitizedText)` durante o streaming em O(N)
 * e executa verificação determinística de citações ao finalizar.
 */
async function streamAnswer({
  question,
  sources = [],
  priorTurns = [],
  onDelta,
  env = process.env,
  selectedModel = '',
  searchLang = '',
  focusMode = 'web',
  intent = '',
  signal = null,
  requestFn = request,
  customStreamFn = null
}) {
  const config = resolveLlmConfig(env, selectedModel);
  const responseProfile = classifyResponseProfile(question, { focusMode, intent });
  const numCtx = config.numCtx || DEFAULT_OLLAMA_NUM_CTX;
  const budgetedSources = fitSourcesToTokenBudget(sources, numCtx);
  const systemPrompt = buildSystemPrompt(budgetedSources.length, searchLang, responseProfile);
  const messages = buildConversationMessages(priorTurns, question, budgetedSources, searchLang, {
    ...responseProfile,
    numCtx
  });

  if (typeof customStreamFn === 'function') {
    const sanitizer = createIncrementalCitationSanitizer(budgetedSources.length);
    for await (const delta of customStreamFn({
      config,
      systemPrompt,
      messages,
      sources: budgetedSources,
      question,
      priorTurns,
      responseProfile,
      signal
    })) {
      if (signal && signal.aborted) break;
      const clean = sanitizer.push(delta);
      if (onDelta) onDelta(delta, clean);
    }
    const finalText = sanitizer.finalize(false);
    const citationVerification = verifyCitationGrounding(finalText, budgetedSources);
    if (citationVerification.totalCitations > 0 && citationVerification.faithfulnessScore < 0.5) {
      console.warn(
        `[DeepEvil][CitationGrounding] Baixa fidelidade (${citationVerification.faithfulnessScore}, ${citationVerification.verifiedCitations}/${citationVerification.totalCitations}):`,
        citationVerification.warnings.slice(0, 3)
      );
    }
    return {
      text: finalText,
      provider: config.provider,
      model: config.model,
      aborted: Boolean(signal && signal.aborted),
      responseProfile,
      citationVerification
    };
  }

  if (!config.apiKey) {
    throw new Error(
      'Nenhuma chave de LLM configurada no arquivo .env. Defina ANTHROPIC_API_KEY ou OPENAI_API_KEY.'
    );
  }

  if (budgetedSources.length === 0) {
    const fallbackMsg =
      'Não foi possível obter e extrair conteúdo legível das páginas retornadas pela busca para responder a esta pergunta com segurança. Verifique sua conexão ou tente reformular os termos da pesquisa.';
    if (onDelta) onDelta(fallbackMsg, fallbackMsg);
    return {
      text: fallbackMsg,
      provider: config.provider,
      model: config.model,
      aborted: false,
      responseProfile,
      citationVerification: {
        totalCitations: 0,
        verifiedCitations: 0,
        unverifiedCitations: 0,
        faithfulnessScore: 1,
        warnings: []
      }
    };
  }

  const sanitizer = createIncrementalCitationSanitizer(budgetedSources.length);
  const handleToken = (delta) => {
    if (!delta || (signal && signal.aborted)) return;
    const sanitized = sanitizer.push(delta);
    if (onDelta) {
      onDelta(delta, sanitized);
    }
  };

  try {
    if (config.provider === 'ollama') {
      await streamFromOllama({
        baseUrl: config.baseUrl || DEFAULT_OLLAMA_BASE_URL,
        model: config.model,
        numCtx,
        numPredict: responseProfile.numPredict,
        temperature: responseProfile.temperature,
        systemPrompt,
        messages,
        onToken: handleToken,
        signal,
        requestFn
      });
    } else if (config.provider === 'openai') {
      await streamFromOpenAI({
        apiKey: config.apiKey,
        model: config.model,
        maxTokens: responseProfile.numPredict,
        temperature: responseProfile.temperature,
        systemPrompt,
        messages,
        onToken: handleToken,
        signal,
        requestFn
      });
    } else {
      await streamFromAnthropic({
        apiKey: config.apiKey,
        model: config.model,
        maxTokens: responseProfile.numPredict,
        temperature: responseProfile.temperature,
        systemPrompt,
        messages,
        onToken: handleToken,
        signal,
        requestFn
      });
    }
  } catch (err) {
    if (signal && signal.aborted) {
      return {
        text: sanitizer.finalize(false),
        provider: config.provider,
        model: config.model,
        aborted: true,
        responseProfile
      };
    }
    throw err;
  }

  const finalText = sanitizer.finalize(false);
  const aborted = Boolean(signal && signal.aborted);
  const citationVerification = aborted
    ? null
    : verifyCitationGrounding(finalText, budgetedSources);

  if (citationVerification && citationVerification.totalCitations > 0 && citationVerification.faithfulnessScore < 0.5) {
    console.warn(
      `[DeepEvil][CitationGrounding] Baixa fidelidade (${citationVerification.faithfulnessScore}, ${citationVerification.verifiedCitations}/${citationVerification.totalCitations}):`,
      citationVerification.warnings.slice(0, 3)
    );
  }

  return {
    text: finalText,
    provider: config.provider,
    model: config.model,
    aborted,
    responseProfile,
    citationVerification
  };
}

async function readErrorBodySafely(response) {
  if (!response?.body) return '';
  if (typeof response.body.text === 'function') {
    try {
      return await response.body.text();
    } catch (_) {
      if (typeof response.body.dump === 'function') {
        await response.body.dump().catch(() => {});
      }
      return '';
    }
  }
  if (typeof response.body.dump === 'function') {
    await response.body.dump().catch(() => {});
  }
  return '';
}

async function streamFromOllama({
  baseUrl,
  model,
  numCtx,
  numPredict = 1500,
  temperature = 0.15,
  systemPrompt,
  messages,
  onToken,
  signal,
  requestFn
}) {
  if (requestFn === request) {
    ensureWslKeepAliveHolder();
  }
  const ollamaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const effectiveNumCtx =
    requestFn === request && !/granite|nemotron|lfm|kimi-linear|step3\.5|ling3/i.test(String(model || ''))
      ? Math.min(Number(numCtx) || DEFAULT_OLLAMA_NUM_CTX, 12288)
      : numCtx;

  const reqOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close'
    },
    headersTimeout: 120000,
    bodyTimeout: 120000,
    body: JSON.stringify({
      model,
      stream: true,
      think: false,
      keep_alive: '24h',
      options: {
        temperature,
        top_p: 0.9,
        repeat_penalty: 1.12,
        num_predict: numPredict,
        num_ctx: effectiveNumCtx
      },
      messages: ollamaMessages
    })
  };
  if (signal) reqOpts.signal = signal;

  const sendWithAutoWake = async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await requestFn(`${baseUrl}/api/chat`, reqOpts);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err?.code || '');
        const isTransientSocketErr = /ECONNRESET|ECONNREFUSED|UND_ERR_SOCKET|SocketError|other side closed|EPIPE|Invalid EOF state/i.test(msg);
        if (!isTransientSocketErr || attempt === 3 || (signal && signal.aborted)) {
          throw err;
        }
        await tryWakeLocalOllama();
        await new Promise((r) => setTimeout(r, attempt * 1200));
      }
    }
    throw lastErr;
  };

  let emittedTokens = 0;

  for (let outerAttempt = 1; outerAttempt <= 3; outerAttempt++) {
    try {
      let response = await sendWithAutoWake();

      // Fallback transparente priorizando o campeão local eriktonon/deepseek-v4.1-flash-1017:9b
      if (response.statusCode === 404 && /(?:granite4\.2-uncensored|deepseek-v4\.1)/i.test(model)) {
        const fallbackCandidates = [
          'eriktonon/deepseek-v4.1-flash-1017:9b',
          model === 'granite4.2-uncensored:latest' ? 'eriktonon/granite4.2-uncensored:latest' : 'granite4.2-uncensored:latest',
          'eriktonon/granite4.2-uncensored:8b'
        ];
        for (const altModel of fallbackCandidates) {
          if (response.statusCode !== 404) break;
          if (response.body && typeof response.body.dump === 'function') {
            await response.body.dump().catch(() => {});
          }
          reqOpts.body = JSON.stringify({
            ...JSON.parse(reqOpts.body),
            model: altModel
          });
          response = await sendWithAutoWake();
        }
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const errBody = await readErrorBodySafely(response);
        throw new Error(`Ollama API (${baseUrl}) retornou HTTP ${response.statusCode}: ${errBody.slice(0, 260)}`);
      }

      let buffer = '';
      for await (const chunk of response.body) {
        if (signal && signal.aborted) break;
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (signal && signal.aborted) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          const cleanLine = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
          if (!cleanLine || cleanLine === '[DONE]') continue;
          try {
            const event = JSON.parse(cleanLine);
            if (event.error) {
              throw new Error(`Erro no Ollama: ${event.error}`);
            }
            const delta = event?.message?.content ?? event?.choices?.[0]?.delta?.content;
            if (delta) {
              emittedTokens += 1;
              onToken(delta);
            }
          } catch (err) {
            if (err.message && err.message.startsWith('Erro no Ollama:')) throw err;
          }
        }
      }

      if (buffer.trim() && !(signal && signal.aborted)) {
        const cleanLine = buffer.trim().startsWith('data:') ? buffer.trim().slice(5).trim() : buffer.trim();
        try {
          const event = JSON.parse(cleanLine);
          const delta = event?.message?.content ?? event?.choices?.[0]?.delta?.content;
          if (delta) {
            emittedTokens += 1;
            onToken(delta);
          }
        } catch (_) {
          // Ignora resíduo final
        }
      }
      return;
    } catch (streamErr) {
      const msg = String(streamErr?.message || streamErr?.code || '');
      const isReset = /ECONNRESET|ECONNREFUSED|UND_ERR_SOCKET|SocketError|other side closed|EPIPE|Invalid EOF state/i.test(msg);
      if (!isReset || emittedTokens > 0 || outerAttempt === 3 || (signal && signal.aborted)) {
        throw streamErr;
      }
      await tryWakeLocalOllama();
      await new Promise((r) => setTimeout(r, outerAttempt * 1500));
    }
  }
}

async function streamFromAnthropic({
  apiKey,
  model,
  maxTokens = 1500,
  temperature = 0.1,
  systemPrompt,
  messages,
  onToken,
  signal,
  requestFn
}) {
  const reqOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    headersTimeout: REMOTE_LLM_HEADERS_TIMEOUT_MS,
    bodyTimeout: REMOTE_LLM_BODY_TIMEOUT_MS,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      system: systemPrompt,
      messages
    })
  };
  if (signal) reqOpts.signal = signal;

  const response = await requestFn(ANTHROPIC_API_URL, reqOpts);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errBody = await readErrorBodySafely(response);
    throw new Error(`Anthropic API retornou HTTP ${response.statusCode}: ${errBody.slice(0, 260)}`);
  }

  await parseSseStream(response.body, (dataStr) => {
    if (signal && signal.aborted) return;
    if (!dataStr || dataStr === '[DONE]') return;
    try {
      const event = JSON.parse(dataStr);
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        onToken(event.delta.text);
      } else if (event.type === 'error') {
        throw new Error(event.error?.message || 'Erro no stream da Anthropic');
      }
    } catch (err) {
      if (err.message && err.message.includes('Anthropic')) throw err;
    }
  });
}

async function streamFromOpenAI({
  apiKey,
  model,
  maxTokens = 1500,
  temperature = 0.1,
  systemPrompt,
  messages,
  onToken,
  signal,
  requestFn
}) {
  const openAiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const reqOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    headersTimeout: REMOTE_LLM_HEADERS_TIMEOUT_MS,
    bodyTimeout: REMOTE_LLM_BODY_TIMEOUT_MS,
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      messages: openAiMessages
    })
  };
  if (signal) reqOpts.signal = signal;

  const response = await requestFn(OPENAI_API_URL, reqOpts);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errBody = await readErrorBodySafely(response);
    throw new Error(`OpenAI API retornou HTTP ${response.statusCode}: ${errBody.slice(0, 260)}`);
  }

  await parseSseStream(response.body, (dataStr) => {
    if (signal && signal.aborted) return;
    if (!dataStr || dataStr === '[DONE]') return;
    try {
      const event = JSON.parse(dataStr);
      const delta = event?.choices?.[0]?.delta?.content;
      if (delta) {
        onToken(delta);
      }
    } catch (_) {
      // Ignora linha parcial inválida
    }
  });
}

async function parseSseStream(readableBody, onDataLine) {
  let buffer = '';
  for await (const chunk of readableBody) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      onDataLine(dataStr);
    }
  }
  if (buffer.trim().startsWith('data:')) {
    onDataLine(buffer.trim().slice(5).trim());
  }
}

/**
 * Traduz o Markdown de uma resposta já gerada para o idioma de destino (`targetLang`)
 * preservando rigorosamente a formatação Markdown (`##`, `**`, listas, tabelas, código)
 * e todas as citações inline `[1][2]`. Suporta streaming via `onDelta`.
 */
async function translateTurnMarkdown({
  markdownText = '',
  targetLang = 'pt-BR',
  sources = [],
  onDelta = null,
  env = process.env,
  selectedModel = '',
  signal = null,
  requestFn = request,
  customTranslateFn = null
} = {}) {
  const cleanSourceMd = String(markdownText || '').trim();
  if (!cleanSourceMd) {
    return {
      text: '',
      targetLang,
      languageLabel: SUPPORTED_TRANSLATION_LANGUAGES[targetLang] || targetLang,
      provider: 'none',
      model: ''
    };
  }

  const languageLabel = SUPPORTED_TRANSLATION_LANGUAGES[targetLang] || targetLang;
  const config = resolveLlmConfig(env, selectedModel);

  const systemPrompt = [
    'You are a fast, accurate technical translator for the DeepEvil answer engine.',
    `Translate the user-provided Markdown text into ${languageLabel}.`,
    'STRICT RULES:',
    '1. Preserve ALL citation markers like [1], [2], [1][3] in their exact positions. NEVER remove or renumber bracketed numbers.',
    '2. Preserve ALL Markdown structure: headings (##), bold (**text**), bullet lists (-), tables, and code (`code`).',
    '3. Preserve proper nouns, code identifiers, CLI commands, file paths, technical acronyms, and brand names exactly as in the original (preserve nomes próprios, identificadores de código, comandos CLI, siglas técnicas e marcas exatamente como no original).',
    '4. Output ONLY the translated Markdown text.'
  ].join('\n');

  const messages = [
    {
      role: 'user',
      content: cleanSourceMd
    }
  ];

  if (typeof customTranslateFn === 'function') {
    const rawOut = await customTranslateFn({
      markdownText: cleanSourceMd,
      targetLang,
      languageLabel,
      config,
      systemPrompt,
      messages,
      signal
    });
    const sanitized = sanitizeCitations(String(rawOut || '').trim(), sources.length);
    if (onDelta) onDelta(sanitized, sanitized);
    return {
      text: sanitized,
      targetLang,
      languageLabel,
      provider: config.provider,
      model: config.model
    };
  }

  const sanitizer = createIncrementalCitationSanitizer(sources.length);
  const handleToken = (delta) => {
    if (!delta || (signal && signal.aborted)) return;
    const sanitized = sanitizer.push(delta);
    if (onDelta) {
      onDelta(delta, sanitized);
    }
  };

  if (config.provider === 'ollama') {
    await streamFromOllama({
      baseUrl: config.baseUrl || DEFAULT_OLLAMA_BASE_URL,
      model: config.model,
      numCtx: config.numCtx || DEFAULT_OLLAMA_NUM_CTX,
      numPredict: 2048,
      temperature: 0.1,
      systemPrompt,
      messages,
      onToken: handleToken,
      signal,
      requestFn
    });
  } else if (config.provider === 'openai') {
    await streamFromOpenAI({
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: 2048,
      temperature: 0.1,
      systemPrompt,
      messages,
      onToken: handleToken,
      signal,
      requestFn
    });
  } else {
    await streamFromAnthropic({
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: 2048,
      temperature: 0.1,
      systemPrompt,
      messages,
      onToken: handleToken,
      signal,
      requestFn
    });
  }

  return {
    text: sanitizer.finalize(true),
    targetLang,
    languageLabel,
    provider: config.provider,
    model: config.model
  };
}

module.exports = {
  SUPPORTED_TRANSLATION_LANGUAGES,
  RESPONSE_PROFILES,
  resolveLlmConfig,
  listOllamaModels,
  clearOllamaModelsCache,
  classifyResponseProfile,
  estimateTokenCount,
  fitSourcesToTokenBudget,
  buildSystemPrompt,
  summarizePriorTurnContext,
  buildUserPromptWithExcerpts,
  buildConversationMessages,
  sanitizeCitations,
  createIncrementalCitationSanitizer,
  verifyCitationGrounding,
  streamAnswer,
  translateTurnMarkdown,
  cleanupWslKeepAlive
};
