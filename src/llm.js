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
 * instalados e permitir seleção dinâmica na interface.
 */
async function listOllamaModels({ env = process.env, requestFn = request } = {}) {
  if (requestFn === request) {
    ensureWslKeepAliveHolder();
  }
  const baseUrl = String(env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, '');
  const defaultModel = String(env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim();

  try {
    const response = await requestFn(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      headersTimeout: 2500,
      bodyTimeout: 2500
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
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

    // Garante que o defaultModel ou eriktonon/granite4.2-uncensored apareça primeiro se estiver na lista
    filtered.sort((a, b) => {
      if (a.name === defaultModel) return -1;
      if (b.name === defaultModel) return 1;
      if (a.name === 'eriktonon/granite4.2-uncensored:latest') return -1;
      if (b.name === 'eriktonon/granite4.2-uncensored:latest') return 1;
      return a.name.localeCompare(b.name);
    });

    return filtered;
  } catch (_) {
    if (requestFn === request) {
      tryWakeLocalOllama().catch(() => {});
    }
    return [{ name: defaultModel, sizeGb: null, provider: 'ollama' }];
  }
}

/**
 * Gera a instrução de sistema estrita exigindo resposta baseada apenas nos trechos
 * extraídos e citações no formato [1][2].
 */
function buildSystemPrompt(validSourceCount) {
  if (validSourceCount <= 0) {
    return [
      'Você é o DeepEvil, um mecanismo de pesquisa global (Worldwide Research Engine) factual e rigoroso.',
      'Nenhuma página web pôde ser extraída com sucesso para esta consulta.',
      'Informe claramente ao usuário que não foi possível obter trechos legíveis das fontes para fundamentar a resposta e NUNCA invente citações como [1].'
    ].join(' ');
  }

  return [
    'Você é o DeepEvil, um mecanismo de pesquisa técnica e científica global (Worldwide Research Engine) de alta precisão.',
    'REGRAS OBRIGATÓRIAS DE SÍNTESE E COERÊNCIA (JANELA DE CONTEXTO DE 32K TOKENS):',
    '1. FOCO DIRETO E COERÊNCIA 100% COM A PERGUNTA ATUAL: Responda exatamente ao que o usuário perguntou logo no primeiro parágrafo, sem rodeios, sem moralismo, sem introduções genéricas e sem desviar do núcleo técnico/científico solicitado.',
    '2. SÍNTESE MULTI-POLAR INTERNACIONAL (🇺🇸 EUA/EN + 🇨🇳 CHINA/ZH + 🇷🇺 RÚSSIA/RU -> IDIOMA DO USUÁRIO): Os trechos numerados [1]..[N] provêm da Federação Geopolítica Multi-Polo (EUA: ArXiv/OpenAlex US/HN/SWE-bench; China: OpenAlex CN/Tsinghua/Shanghai AI Lab/OpenCompass/DeepSeek/Qwen/Wikipedia ZH; Rússia: Habr/OpenAlex RU/ISP RAS/MIPT/Wikipedia RU). Traduza, compare e integre ativamente os benchmarks, arquiteturas, artigos e descobertas dos três polos internacionais diretamente para o idioma da pergunta do usuário, citando as fontes de cada polo ([1][2][3]...).',
    '3. ISOLAMENTO ESTRITO DAS FONTES ATUAIS: Baseie 100% dos fatos técnicos, protocolos, parâmetros, arquiteturas e números exclusivamente nos trechos [1]..[N] fornecidos NESTE turno. JAMAIS misture ou repita conceitos de turnos anteriores que não estejam presentes nos trechos atuais.',
    '4. CITAÇÕES INLINE OBRIGATÓRIAS: Inclua citações imediatamente após cada fato, data, número ou afirmação técnica usando estritamente colchetes individuais, como [1] ou [1][2]. Nunca agrupe com vírgula como [1, 2] e nunca envolva citações em itálico/parênteses como ([1]); escreva sempre [1][2].',
    `5. INTERVALO VÁLIDO DE CITAÇÃO: Cite APENAS números entre [1] e [${validSourceCount}]. Nunca cite uma fonte fora desse intervalo.`,
    '6. PROFUNDIDADE TÉCNICA E ESTRUTURA EDITORIAL:',
    '   - Comece DIRETAMENTE com um parágrafo de síntese executiva denso e completo respondendo à pergunta, destacando termos técnicos, protocolos, algoritmos, números e entidades críticas em **negrito**, seguidos das citações [1].',
    '   - Desenvolva a resposta em múltiplas subseções técnicas aprofundadas com cabeçalhos Markdown (`##`) específicos do tema pesquisado (NÃO use rótulos genéricos repetitivos como "Trecho-chave:" ou "Defesa prática:").',
    '   - Explore os detalhes técnicos presentes nas fontes: explique mecanismos internos, fluxos de protocolo, parâmetros de configuração, trade-offs de performance e exemplos arquiteturais usando listas (`- **Conceito**: explicação detalhada... [1]`) e tabelas comparativas Markdown (`| Componente | Mecanismo | Impacto |`) quando apropriado.',
    '7. IDIOMA NATIVO E VOCABULÁRIO PRECISO: Redija 100% da resposta e dos cabeçalhos (`##`) no MESMO IDIOMA da pergunta do usuário com ortografia e terminologia técnica impecáveis, mantendo siglas e identificadores de código universais.'
  ].join('\n');
}

/**
 * Remove marcações de citação antigas [1][2] e cabeçalhos de um texto de turno anterior
 * para evitar contaminação de índices [1]..[N] entre turnos distintos.
 */
function summarizePriorTurnContext(priorTurns = []) {
  if (!Array.isArray(priorTurns) || priorTurns.length === 0) return '';
  const recent = priorTurns
    .filter((t) => t && t.question)
    .slice(-2)
    .map((t, idx) => `- Pergunta anterior ${idx + 1}: "${String(t.question).trim()}"`);
  if (recent.length === 0) return '';
  return [
    'CONTEXTO DE NAVEGAÇÃO DA CONVERSA (Use APENAS se a pergunta atual tiver pronomes implícitos como "disso", "ele" ou "nesse caso"; NUNCA repita tópicos anteriores se a pergunta atual já tiver tema próprio):',
    ...recent,
    ''
  ].join('\n');
}

/**
 * Monta o prompt do turno atual com os trechos legíveis numerados [1]..[N].
 */
function buildUserPromptWithExcerpts(question, sources = [], priorTurns = []) {
  if (!sources || sources.length === 0) {
    return [
      'Nenhuma página pôde ser obtida e extraída com sucesso para esta pergunta.',
      '',
      `Pergunta: ${String(question || '').trim()}`,
      '',
      'Explique que nenhuma fonte pôde ser extraída com sucesso nesta tentativa e não inclua nenhuma citação [n].'
    ].join('\n');
  }

  const formattedExcerpts = sources
    .map((src) => {
      return [
        `[${src.citationIndex}] Título: ${src.title}`,
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

  return [
    priorContextBlock,
    'FONTES GLOBAIS EXTRAÍDAS COM SUCESSO PARA ESTE TURNO (PESQUISA WORLDWIDE):',
    '',
    formattedExcerpts,
    '',
    '============================================================',
    `PERGUNTA ATUAL DO USUÁRIO: ${String(question || '').trim()}`,
    '',
    `Instrução Crítica: Elabore uma síntese técnica completa, densa, bem estruturada e 100% focada na PERGUNTA ATUAL DO USUÁRIO utilizando exclusivamente os fatos das fontes [1] a [${sources.length}] acima (traduzindo conceitos do inglês para o idioma da pergunta do usuário). Cite cada afirmação técnica com [1][2].`
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Constrói a mensagem de prompt isolando as citações [1]..[N] do turno atual para
 * evitar contaminação de índices [1][2] e repetição de vocabulário de turnos passados.
 */
function buildConversationMessages(priorTurns = [], currentQuestion = '', currentSources = []) {
  return [
    {
      role: 'user',
      content: buildUserPromptWithExcerpts(currentQuestion, currentSources, priorTurns)
    }
  ];
}

/**
 * Normaliza citações combinadas (ex: "[1, 2]" -> "[1][2]"), corrige eventuais artefatos
 * de tokenização e remove qualquer citação cujo índice não pertença ao conjunto
 * [1..maxCitationIndex] de páginas efetivamente obtidas com sucesso.
 */
function sanitizeCitations(markdownText, maxCitationIndex) {
  let text = String(markdownText || '')
    .replace(/\bConcórvora\b/gi, 'Concorrência')
    .replace(/\bconcórvora\b/g, 'concorrência')
    .replace(/\bMotorres\b/g, 'Motores')
    .replace(/\bmotorres\b/g, 'motores')
    .replace(/\bDescobta\b/g, 'Descoberta')
    .replace(/\bdescobta\b/g, 'descoberta')
    .replace(/\bTécnnicos\b/g, 'Técnicos')
    .replace(/\btécnnicos\b/g, 'técnicos')
    .replace(/\s*\[Trecho:[^\]]*\]/gi, '')
    .replace(/\*+((?:\[\d+\])+)\*+/g, '$1')
    .replace(/\(((?:\[\d+\])+)\)/g, '$1');

  if (maxCitationIndex <= 0) {
    return text.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '');
  }

  // Converte listas como [1, 2] ou [1, 2, 3] em [1][2][3]
  const expanded = text.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, listStr) => {
    return listStr
      .split(',')
      .map((part) => `[${part.trim()}]`)
      .join('');
  });

  // Mantém apenas [n] onde 1 <= n <= maxCitationIndex
  return expanded.replace(/\[(\d+)\]/g, (full, numStr) => {
    const n = Number(numStr);
    if (Number.isInteger(n) && n >= 1 && n <= maxCitationIndex) {
      return `[${n}]`;
    }
    return '';
  });
}

/**
 * Realiza streaming da resposta do Claude (Anthropic) ou GPT (OpenAI) via undici.
 * Chama `onDelta(deltaText, accumulatedSanitizedText)` a cada token recebido.
 */
async function streamAnswer({
  question,
  sources = [],
  priorTurns = [],
  onDelta,
  env = process.env,
  selectedModel = '',
  signal = null,
  requestFn = request,
  customStreamFn = null
}) {
  const config = resolveLlmConfig(env, selectedModel);
  const systemPrompt = buildSystemPrompt(sources.length);
  const messages = buildConversationMessages(priorTurns, question, sources);

  if (typeof customStreamFn === 'function') {
    let rawAccumulated = '';
    for await (const delta of customStreamFn({ config, systemPrompt, messages, sources, question, priorTurns, signal })) {
      if (signal && signal.aborted) break;
      rawAccumulated += delta;
      const clean = sanitizeCitations(rawAccumulated, sources.length);
      if (onDelta) onDelta(delta, clean);
    }
    return {
      text: sanitizeCitations(rawAccumulated, sources.length),
      provider: config.provider,
      model: config.model,
      aborted: Boolean(signal && signal.aborted)
    };
  }

  if (!config.apiKey) {
    throw new Error(
      'Nenhuma chave de LLM configurada no arquivo .env. Defina ANTHROPIC_API_KEY ou OPENAI_API_KEY.'
    );
  }

  if (sources.length === 0) {
    const fallbackMsg =
      'Não foi possível obter e extrair conteúdo legível das páginas retornadas pela busca para responder a esta pergunta com segurança. Verifique sua conexão ou tente reformular os termos da pesquisa.';
    if (onDelta) onDelta(fallbackMsg, fallbackMsg);
    return {
      text: fallbackMsg,
      provider: config.provider,
      model: config.model,
      aborted: false
    };
  }

  let rawAccumulated = '';
  const handleToken = (delta) => {
    if (!delta || (signal && signal.aborted)) return;
    rawAccumulated += delta;
    const sanitized = sanitizeCitations(rawAccumulated, sources.length);
    if (onDelta) {
      onDelta(delta, sanitized);
    }
  };

  try {
    if (config.provider === 'ollama') {
      await streamFromOllama({
        baseUrl: config.baseUrl || DEFAULT_OLLAMA_BASE_URL,
        model: config.model,
        numCtx: config.numCtx || DEFAULT_OLLAMA_NUM_CTX,
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
        text: sanitizeCitations(rawAccumulated, sources.length),
        provider: config.provider,
        model: config.model,
        aborted: true
      };
    }
    throw err;
  }

  return {
    text: sanitizeCitations(rawAccumulated, sources.length),
    provider: config.provider,
    model: config.model,
    aborted: Boolean(signal && signal.aborted)
  };
}

async function streamFromOllama({ baseUrl, model, numCtx, systemPrompt, messages, onToken, signal, requestFn }) {
  if (requestFn === request) {
    ensureWslKeepAliveHolder();
  }
  const ollamaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const reqOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connection': 'close'
    },
    headersTimeout: 120000,
    bodyTimeout: 120000,
    body: JSON.stringify({
      model,
      stream: true,
      think: false,
      keep_alive: '24h',
      options: {
        temperature: 0.15,
        top_p: 0.9,
        repeat_penalty: 1.12,
        num_predict: 2048,
        num_ctx: numCtx
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

      // Fallback transparente entre o alias local (granite4.2-uncensored:latest) e o namespace público no Ollama Hub (eriktonon/granite4.2-uncensored:latest)
      if (response.statusCode === 404 && (model === 'granite4.2-uncensored:latest' || model === 'eriktonon/granite4.2-uncensored:latest')) {
        if (response.body && typeof response.body.dump === 'function') {
          await response.body.dump().catch(() => {});
        }
        const altModel = model === 'granite4.2-uncensored:latest'
          ? 'eriktonon/granite4.2-uncensored:latest'
          : 'granite4.2-uncensored:latest';
        reqOpts.body = JSON.stringify({
          ...JSON.parse(reqOpts.body),
          model: altModel
        });
        response = await sendWithAutoWake();
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const errBody = await response.body.text().catch(() => '');
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

async function streamFromAnthropic({ apiKey, model, systemPrompt, messages, onToken, signal, requestFn }) {
  const reqOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.1,
      stream: true,
      system: systemPrompt,
      messages
    })
  };
  if (signal) reqOpts.signal = signal;

  const response = await requestFn(ANTHROPIC_API_URL, reqOpts);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errBody = await response.body.text().catch(() => '');
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

async function streamFromOpenAI({ apiKey, model, systemPrompt, messages, onToken, signal, requestFn }) {
  const openAiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const reqOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 1500,
      stream: true,
      messages: openAiMessages
    })
  };
  if (signal) reqOpts.signal = signal;

  const response = await requestFn(OPENAI_API_URL, reqOpts);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errBody = await response.body.text().catch(() => '');
    throw new Error(`OpenAI API retornou HTTP ${response.statusCode}: ${errBody.slice(0, 260)}`);
  }

  await parseSseStream(response.body, (dataStr) => {
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

const SUPPORTED_TRANSLATION_LANGUAGES = {
  'pt-BR': 'Português do Brasil (pt-BR)',
  en: 'English (en-US)',
  es: 'Español (es)',
  fr: 'Français (fr)',
  de: 'Deutsch (de)'
};

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
    `You are a fast, accurate technical translator for the DeepEvil answer engine.`,
    `Translate the user-provided Markdown text into ${languageLabel}.`,
    `STRICT RULES:`,
    `1. Preserve ALL citation markers like [1], [2], [1][3] in their exact positions. NEVER remove or renumber bracketed numbers.`,
    `2. Preserve ALL Markdown structure: headings (##), bold (**text**), bullet lists (-), tables, and code (\`code\`).`,
    `3. Keep technical identifiers, syscall names, paths, and proper nouns intact (ftrace, sys_call_table, kallsyms_lookup_name, HNSW, Raft, WAL).`,
    `4. Output ONLY the translated Markdown text.`
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
      messages
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

  let rawAccumulated = '';
  const handleToken = (delta) => {
    if (!delta) return;
    rawAccumulated += delta;
    if (onDelta) {
      onDelta(delta, sanitizeCitations(rawAccumulated, sources.length));
    }
  };

  if (config.provider === 'ollama') {
    await streamFromOllama({
      baseUrl: config.baseUrl || DEFAULT_OLLAMA_BASE_URL,
      model: config.model,
      numCtx: config.numCtx || DEFAULT_OLLAMA_NUM_CTX,
      systemPrompt,
      messages,
      onToken: handleToken,
      requestFn
    });
  } else if (config.provider === 'openai') {
    await streamFromOpenAI({
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages,
      onToken: handleToken,
      requestFn
    });
  } else {
    await streamFromAnthropic({
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages,
      onToken: handleToken,
      requestFn
    });
  }

  return {
    text: sanitizeCitations(rawAccumulated.trim(), sources.length),
    targetLang,
    languageLabel,
    provider: config.provider,
    model: config.model
  };
}

module.exports = {
  SUPPORTED_TRANSLATION_LANGUAGES,
  resolveLlmConfig,
  listOllamaModels,
  buildSystemPrompt,
  buildUserPromptWithExcerpts,
  buildConversationMessages,
  sanitizeCitations,
  streamAnswer,
  translateTurnMarkdown
};

