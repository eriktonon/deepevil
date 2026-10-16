'use strict';

const { request } = require('undici');
const { JSDOM } = require('jsdom');

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
const DUCKDUCKGO_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
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

  const words = cleanQuestion.split(/\s+/).filter(Boolean);
  const needsContext =
    words.length < 7 ||
    /^¿?(e\b|mas\b|como\b|qual\b|quais\b|quanto\b|por que\b|porque\b|onde\b|quando\b|isso\b|ele\b|ela\b|eles\b|deles\b|disso\b|nesse\b|nessa\b|what about|how about|and\b|why\b|y\b|pero\b|cómo\b|cuál\b|cuáles\b|qué\b|por qué\b|dónde\b|cuándo\b|quién\b)/i.test(cleanQuestion);

  if (!needsContext) {
    return cleanQuestion.slice(0, 380);
  }

  const anchor = lastQuestion && lastQuestion !== firstQuestion
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
 * Busca web direta via DuckDuckGo HTML (undici + jsdom) sem necessidade de chave ou container.
 */
async function searchKeylessWeb(query, { httpRequest = request, timeoutMs = 8000, count = MAX_RESULTS } = {}) {
  const url = new URL(DUCKDUCKGO_HTML_ENDPOINT);
  url.searchParams.set('q', String(query || '').trim());

  try {
    const response = await httpRequest(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        results: [],
        provider: 'keyless-web',
        error: `Busca web sem chave retornou HTTP ${response.statusCode}`
      };
    }

    const html = await response.body.text();
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

    return {
      results: normalizeTopResults(candidates, count),
      provider: 'keyless-web',
      error: null
    };
  } catch (err) {
    return {
      results: [],
      provider: 'keyless-web',
      error: `Falha na busca keyless: ${err?.message || String(err)}`
    };
  }
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
