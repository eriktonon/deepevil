'use strict';

const { request } = require('undici');
const { JSDOM } = require('jsdom');

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
const DUCKDUCKGO_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const BING_HTML_ENDPOINT = 'https://www.bing.com/search';
const MAX_RESULTS = 6;

/**
 * Constrói uma query de busca contextualizada quando a pergunta atual é um follow-up
 * dentro de uma conversa existente.
 */
function buildContextualSearchQuery(question, priorTurns = []) {
  const cleanQuestion = String(question || '').trim();
  if (!priorTurns || priorTurns.length === 0) {
    return cleanQuestion.slice(0, 380);
  }

  const firstQuestion = String(priorTurns[0]?.question || '').trim();
  const lastQuestion = String(priorTurns[priorTurns.length - 1]?.question || '').trim();

  // Se a pergunta atual já contém o tema principal da conversa (ex.: chips de follow-up), não duplica
  const firstWords = firstQuestion
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const lowerCurrent = cleanQuestion.toLowerCase();
  if (firstWords.length > 0) {
    const matchedCount = firstWords.filter((w) => lowerCurrent.includes(w)).length;
    if (matchedCount / firstWords.length >= 0.5) {
      return cleanQuestion.slice(0, 380);
    }
  }

  const words = cleanQuestion.split(/\s+/).filter(Boolean);
  // Uma única palavra isolada (ex.: "granadas", "novelas") é tratada como novo tópico direto
  if (words.length === 1 && !/^(isso|ele|ela|eles|elas|porquê|porque|why|how)$/i.test(words[0])) {
    return cleanQuestion.slice(0, 380);
  }

  const needsContext =
    words.length < 7 ||
    /^¿?(e\b|mas\b|como\b|qual\b|quais\b|quanto\b|por que\b|porque\b|onde\b|quando\b|isso\b|ele\b|ela\b|eles\b|deles\b|disso\b|nesse\b|nessa\b|what about|how about|and\b|why\b|y\b|pero\b|cómo\b|cuál\b|cuáles\b|qué\b|por qué\b|dónde\b|cuándo\b|quién\b)/i.test(cleanQuestion);

  if (!needsContext) {
    return cleanQuestion.slice(0, 380);
  }

  const anchor = lastQuestion && lastQuestion !== firstQuestion && !lastQuestion.includes(firstQuestion)
    ? `${firstQuestion} ${lastQuestion}`
    : firstQuestion;

  const combined = `${anchor} — ${cleanQuestion}`.replace(/\s+/g, ' ').trim();
  return combined.slice(0, 380);
}

/**
 * Normaliza e filtra até `count` URLs HTTP/HTTPS únicas de uma lista bruta.
 */
function normalizeTopResults(rawItems = [], count = MAX_RESULTS) {
  const seenUrls = new Set();
  const topResults = [];

  for (const item of rawItems) {
    if (!item || typeof item.url !== 'string') continue;
    let parsedUrl;
    try {
      parsedUrl = new URL(item.url);
    } catch (_) {
      continue;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      continue;
    }
    // Converte subdomínio mobile da Wikipédia (pt.m.wikipedia.org -> pt.wikipedia.org)
    if (parsedUrl.hostname.endsWith('.m.wikipedia.org')) {
      parsedUrl.hostname = parsedUrl.hostname.replace('.m.wikipedia.org', '.wikipedia.org');
    }
    const normalizedUrl = parsedUrl.toString();
    if (seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);

    topResults.push({
      url: normalizedUrl,
      title: String(item.title || parsedUrl.hostname).replace(/\s+/g, ' ').trim(),
      description: String(item.description || item.content || '').replace(/\s+/g, ' ').trim()
    });

    if (topResults.length >= count) {
      break;
    }
  }

  return topResults;
}

/**
 * Consulta uma instância SearXNG (meta-buscador open-source 100% gratuito e sem chave)
 * via undici em formato JSON (`/search?q=...&format=json`) e obtém os 6 principais resultados.
 */
async function searchSearxng(query, {
  baseUrl = DEFAULT_SEARXNG_URL,
  httpRequest = request,
  timeoutMs = 8000,
  count = MAX_RESULTS
} = {}) {
  const cleanBase = String(baseUrl || DEFAULT_SEARXNG_URL).trim().replace(/\/+$/, '');
  const url = new URL(`${cleanBase}/search`);
  url.searchParams.set('q', String(query || '').trim());
  url.searchParams.set('format', 'json');

  try {
    const response = await httpRequest(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PerplexityLocal/1.0 (Localhost Answer Engine)'
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        results: [],
        provider: 'searxng',
        error: `SearXNG (${cleanBase}) retornou HTTP ${response.statusCode}`
      };
    }

    const payload = await response.body.json();
    const rawResults = Array.isArray(payload?.results) ? payload.results : [];
    const topResults = normalizeTopResults(rawResults, count);

    return {
      results: topResults,
      provider: 'searxng',
      error: null
    };
  } catch (err) {
    return {
      results: [],
      provider: 'searxng',
      error: `Falha ao consultar SearXNG (${cleanBase}): ${err?.message || String(err)}`
    };
  }
}

/**
 * Reescreve consultas do tipo "como fazer <X>" / "how to make <X>" para termos técnicos
 * caso o motor de busca aplique filtro de palavra-chave (ex.: Bing trocando "como fazer napalm" por "Fazer - Dicio").
 */
function rewriteQueryForTechnicalSearch(rawQuery) {
  const clean = String(rawQuery || '').trim();
  const match = clean.match(/^(?:como\s+(?:fazer|fabricar|produzir|criar|montar)|how\s+to\s+(?:make|build|create|synthesize))\s+(.+)$/i);
  if (match && match[1]) {
    const subject = match[1].replace(/[?!.]+$/, '').trim();
    return `${subject} composição química síntese funcionamento história`;
  }
  return clean;
}

/**
 * Busca web via Bing HTML (`adlt=off`) com decodificação de links `u=a1<base64url>`.
 */
async function searchBingHtml(query, { httpRequest = request, timeoutMs = 8000, count = MAX_RESULTS } = {}) {
  const effectiveQuery = rewriteQueryForTechnicalSearch(query);
  const url = new URL(BING_HTML_ENDPOINT);
  url.searchParams.set('q', effectiveQuery);
  url.searchParams.set('adlt', 'off');

  try {
    const response = await httpRequest(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': 'SRCHHPGUSR=ADLT=OFF'
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });

    if (response.statusCode !== 200) {
      return [];
    }

    const html = await response.body.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const items = [...doc.querySelectorAll('li.b_algo')];

    const candidates = [];
    for (const li of items) {
      const a = li.querySelector('h2 a');
      if (!a) continue;
      let resolvedUrl = a.getAttribute('href') || '';
      if (!resolvedUrl) continue;

      try {
        const parsed = new URL(resolvedUrl, BING_HTML_ENDPOINT);
        const uParam = parsed.searchParams.get('u');
        if (uParam && uParam.startsWith('a1')) {
          resolvedUrl = Buffer.from(uParam.slice(2), 'base64url').toString('utf8');
        } else {
          resolvedUrl = parsed.toString();
        }
      } catch (_) {
        continue;
      }

      if (!resolvedUrl.startsWith('http') || resolvedUrl.includes('bing.com')) continue;
      const snippetEl = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3');
      candidates.push({
        url: resolvedUrl,
        title: String(a.textContent || '').trim(),
        description: String(snippetEl?.textContent || '').trim()
      });
    }

    return normalizeTopResults(candidates, count);
  } catch (_) {
    return [];
  }
}

/**
 * Fallback complementar via API JSON da Wikipédia (PT + EN) para garantir fontes enciclopédicas
 * caso os buscadores HTML bloqueiem ou limitem a consulta.
 */
async function searchWikipediaFallback(query, { httpRequest = request, timeoutMs = 6000, count = MAX_RESULTS } = {}) {
  const stripped = String(query || '')
    .replace(/^(?:como\s+(?:fazer|fabricar|funciona|usar)|o\s+que\s+[eé]|qual\s+[ea]|quais\s+(?:são|os|as)|how\s+to\s+\w+|what\s+is)\s+/i, '')
    .replace(/[?!.]+$/, '')
    .trim();
  const targetQuery = stripped || String(query || '').trim();
  if (!targetQuery) return [];

  const candidates = [];
  for (const lang of ['pt', 'en']) {
    try {
      const apiUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(targetQuery)}&utf8=&format=json&srlimit=${count}`;
      const res = await httpRequest(apiUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'DeepEvil/1.0 (Localhost Answer Engine)' },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs
      });
      if (res.statusCode !== 200) continue;
      const data = await res.body.json();
      const searchItems = Array.isArray(data?.query?.search) ? data.query.search : [];
      for (const s of searchItems) {
        if (!s?.title) continue;
        candidates.push({
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, '_'))}`,
          title: `${s.title} — Wikipédia (${lang.toUpperCase()})`,
          description: String(s.snippet || '').replace(/<[^>]+>/g, '').trim()
        });
      }
      if (candidates.length >= count) break;
    } catch (_) {
      // Continua para o próximo idioma
    }
  }
  return normalizeTopResults(candidates, count);
}

/**
 * Busca web direta resiliente multi-motor (DuckDuckGo HTML -> Bing HTML -> Wikipedia API)
 * sem necessidade de chave ou container.
 */
async function searchKeylessWeb(query, { httpRequest = request, timeoutMs = 8000, count = MAX_RESULTS } = {}) {
  const effectiveQuery = rewriteQueryForTechnicalSearch(query);
  const url = new URL(DUCKDUCKGO_HTML_ENDPOINT);
  url.searchParams.set('q', effectiveQuery);

  let lastError = null;

  // 1. Tenta DuckDuckGo HTML (apenas se HTTP === 200 real; HTTP 202 indica CAPTCHA/rate-limit)
  try {
    const response = await httpRequest(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });

    if (response.statusCode === 200) {
      const html = await response.body.text();
      if (!html.includes('anomaly.js') && !html.includes('cc=botnet')) {
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        const anchors = [...doc.querySelectorAll('.result__a')];

        const candidates = [];
        for (const a of anchors) {
          const rawHref = a.getAttribute('href') || '';
          if (!rawHref) continue;

          let resolvedUrl = rawHref;
          try {
            const wrapperUrl = new URL(rawHref, DUCKDUCKGO_HTML_ENDPOINT);
            const uddg = wrapperUrl.searchParams.get('uddg');
            resolvedUrl = uddg || wrapperUrl.toString();
          } catch (_) {
            continue;
          }

          if (resolvedUrl.includes('duckduckgo.com')) continue;
          candidates.push({
            url: resolvedUrl,
            title: String(a.textContent || '').trim(),
            description: ''
          });
        }

        const ddgResults = normalizeTopResults(candidates, count);
        if (ddgResults.length > 0) {
          return {
            results: ddgResults,
            provider: 'keyless-web',
            error: null
          };
        }
      }
    } else {
      if (response.body && typeof response.body.dump === 'function') {
        await response.body.dump().catch(() => {});
      }
      lastError = `Busca web sem chave retornou HTTP ${response.statusCode}`;
    }
  } catch (err) {
    lastError = `Falha na busca keyless: ${err?.message || String(err)}`;
  }

  // 2. Fallback automático para Bing Web Search HTML (adlt=off)
  const bingResults = await searchBingHtml(query, { httpRequest, timeoutMs, count });
  if (bingResults.length >= Math.min(3, count)) {
    return {
      results: bingResults,
      provider: 'keyless-web',
      error: null
    };
  }

  // 3. Fallback complementar via Wikipédia API (PT + EN)
  const wikiResults = await searchWikipediaFallback(query, { httpRequest, timeoutMs, count });
  const merged = normalizeTopResults([...bingResults, ...wikiResults], count);
  if (merged.length > 0) {
    return {
      results: merged,
      provider: 'keyless-web',
      error: null
    };
  }

  return {
    results: [],
    provider: 'keyless-web',
    error: lastError
  };
}

/**
 * Executa a busca web obtendo os 6 principais resultados via undici.
 * Suporta:
 * 1) SearXNG (`SEARCH_PROVIDER=searxng` / `SEARXNG_URL=http://127.0.0.1:8888`) — 100% gratuito e sem chave.
 * 2) Brave Search API (`BRAVE_SEARCH_API_KEY`) quando configurada.
 * 3) Fallback automático sem chave via DuckDuckGo HTML caso o SearXNG não esteja rodando ou a chave Brave não exista.
 */
async function searchBrave(query, options = {}) {
  const env = options.env || process.env;
  const searchProvider = String(options.provider || env.SEARCH_PROVIDER || '').trim().toLowerCase();
  const searxngUrl = String(options.searxngUrl || env.SEARXNG_URL || DEFAULT_SEARXNG_URL).trim();
  const apiKey = options.apiKey ?? env.BRAVE_SEARCH_API_KEY ?? env.BRAVE_API_KEY ?? '';
  const httpRequest = options.requestFn || request;
  const timeoutMs = Number(options.timeoutMs || env.SEARCH_TIMEOUT_MS || 8000);
  const count = Number(options.count || MAX_RESULTS);

  const hasValidBraveKey = Boolean(
    apiKey &&
    apiKey !== 'sua_chave_brave_search_aqui' &&
    apiKey !== 'keyless' &&
    apiKey !== 'searxng'
  );

  // 1. Se options.provider === 'searxng' ou se não há chave Brave real e SEARCH_PROVIDER=searxng (e apiKey !== 'keyless')
  if (options.provider === 'searxng' || (!hasValidBraveKey && apiKey !== 'keyless' && (searchProvider === 'searxng' || apiKey === 'searxng'))) {
    const searxRes = await searchSearxng(query, {
      baseUrl: searxngUrl,
      httpRequest,
      timeoutMs,
      count
    });
    if (searxRes.results.length > 0 || options.disableKeylessFallback) {
      return searxRes;
    }
    // Se o container SearXNG local estiver desligado, faz fallback transparente para busca web direta
    return searchKeylessWeb(query, { httpRequest, timeoutMs, count });
  }

  // 2. Se não há chave Brave válida, tenta SearXNG local primeiro e depois DuckDuckGo HTML
  if (!hasValidBraveKey) {
    if (options.disableKeylessFallback) {
      return {
        results: [],
        provider: 'brave',
        error: 'Chave BRAVE_SEARCH_API_KEY não configurada no arquivo .env.'
      };
    }
    if (apiKey !== 'keyless' && env.SEARXNG_URL) {
      const searxRes = await searchSearxng(query, {
        baseUrl: searxngUrl,
        httpRequest,
        timeoutMs,
        count
      });
      if (searxRes.results.length > 0) return searxRes;
    }
    return searchKeylessWeb(query, { httpRequest, timeoutMs, count });
  }

  // 3. Brave Search API Oficial
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', String(query || '').trim());
  url.searchParams.set('count', String(Math.min(Math.max(count, 1), 20)));
  url.searchParams.set('text_decorations', 'false');

  try {
    const response = await httpRequest(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
        'User-Agent': 'PerplexityLocal/1.0 (Localhost Answer Engine)'
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      let errText = '';
      try {
        errText = await response.body.text();
      } catch (_) {
        // Ignora erro de leitura do corpo
      }
      return {
        results: [],
        provider: 'brave',
        error: `Brave Search API retornou HTTP ${response.statusCode}${errText ? `: ${errText.slice(0, 180)}` : ''}`
      };
    }

    const payload = await response.body.json();
    const rawResults = Array.isArray(payload?.web?.results) ? payload.web.results : [];

    return {
      results: normalizeTopResults(rawResults, count),
      provider: 'brave',
      error: null
    };
  } catch (err) {
    return {
      results: [],
      provider: 'brave',
      error: `Falha ao consultar Brave Search: ${err?.message || String(err)}`
    };
  }
}

module.exports = {
  MAX_RESULTS,
  buildContextualSearchQuery,
  searchBrave,
  searchSearxng,
  searchKeylessWeb
};
