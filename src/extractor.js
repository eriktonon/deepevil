'use strict';

const dns = require('node:dns');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

const { request, Agent, setGlobalDispatcher } = require('undici');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');

try {
  setGlobalDispatcher(
    new Agent({
      connect: {
        rejectUnauthorized: false,
        timeout: 6500
      }
    })
  );
} catch (_) {}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CHARS = 4500;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB limite de segurança para parsing DOM
const MIN_READABLE_CHARS = 80;

/**
 * Baixa uma página web usando undici e extrai o texto legível principal usando
 * @mozilla/readability + jsdom.
 *
 * REGRA CRÍTICA:
 * Se o download HTTP falhar, o content-type não for HTML/texto, ou o Readability
 * não conseguir extrair texto legível suficiente, retorna `null` para que a página
 * seja completamente ignorada e JAMAIS citada.
 */
async function extractReadablePage(targetUrl, fallbackTitle = '', options = {}) {
  const httpRequest = options.requestFn || request;
  const timeoutMs = Number(options.timeoutMs || process.env.PAGE_FETCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const maxChars = Number(options.maxChars || process.env.MAX_CHARS_PER_SOURCE || DEFAULT_MAX_CHARS);

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }
  } catch (_) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options.signal || null;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      return null;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    // Fast-path para repositórios do GitHub: extrai diretamente o README.md completo via raw.githubusercontent.com
    const ghRepoMatch =
      parsedUrl.hostname.replace(/^www\./i, '').toLowerCase() === 'github.com' &&
      parsedUrl.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);

    if (ghRepoMatch && !/^(topics|search|explore|orgs|users|settings|marketplace|pulls|issues)$/i.test(ghRepoMatch[1])) {
      const owner = ghRepoMatch[1];
      const repoClean = ghRepoMatch[2].replace(/\.git$/i, '');
      const rawReadmeUrl = `https://raw.githubusercontent.com/${owner}/${repoClean}/HEAD/README.md`;
      try {
        const readmeRes = await httpRequest(rawReadmeUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'DeepEvil/1.0 (Global Research Engine)' },
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: controller.signal
        });
        if (readmeRes && readmeRes.statusCode >= 200 && readmeRes.statusCode < 300) {
          const mdBody = await readBodyWithLimit(readmeRes.body, MAX_HTML_BYTES);
          const cleanedMd = String(mdBody || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (cleanedMd.length >= MIN_READABLE_CHARS) {
            const excerpt = clipAtBoundary(cleanedMd, maxChars);
            const words = excerpt.split(/\s+/).filter(Boolean);
            return {
              url: `https://github.com/${owner}/${repoClean}`,
              title: fallbackTitle || `${owner}/${repoClean} — GitHub Repository (README.md)`,
              domain: 'github.com',
              siteName: 'github.com',
              excerpt,
              wordCount: words.length,
              charCount: excerpt.length
            };
          }
        } else if (readmeRes?.body && typeof readmeRes.body.dump === 'function') {
          await readmeRes.body.dump().catch(() => {});
        }
      } catch (_) {
        // Continua para extração HTML padrão caso o repositório não tenha README.md em HEAD
      }
    }

    let currentUrl = parsedUrl.toString();
    let response = null;

    for (let hop = 0; hop <= 3; hop++) {
      response = await httpRequest(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.7,pt;q=0.6,*;q=0.5'
        },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: controller.signal
      });

      if (response && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers?.location || response.headers?.Location;
        if (response.body && typeof response.body.dump === 'function') {
          await response.body.dump().catch(() => {});
        }
        if (!location || hop === 3) {
          return null;
        }
        currentUrl = new URL(String(location), currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      if (response?.body && typeof response.body.dump === 'function') {
        await response.body.dump().catch(() => {});
      }
      return null;
    }

    const contentTypeHeader = String(
      response.headers?.['content-type'] || response.headers?.['Content-Type'] || ''
    ).toLowerCase();

    if (
      contentTypeHeader &&
      !contentTypeHeader.includes('text/html') &&
      !contentTypeHeader.includes('application/xhtml+xml') &&
      !contentTypeHeader.includes('text/plain')
    ) {
      if (response?.body && typeof response.body.dump === 'function') {
        await response.body.dump().catch(() => {});
      }
      return null;
    }

    const html = await readBodyWithLimit(response.body, MAX_HTML_BYTES);
    if (!html || html.trim().length < MIN_READABLE_CHARS) {
      return null;
    }

    const virtualConsole = new VirtualConsole();
    // Suprime avisos de CSS inválido em páginas de terceiros
    virtualConsole.on('jsdomError', () => {});

    const dom = new JSDOM(html, {
      url: parsedUrl.toString(),
      virtualConsole
    });

    const doc = dom.window.document;
    // Remove elementos não textuais antes do Readability
    doc.querySelectorAll('script, style, noscript, iframe, svg, canvas, form, nav, footer').forEach((el) => {
      el.remove();
    });

    const reader = new Readability(doc);
    const article = reader.parse();

    let rawText = String(article?.textContent || '').replace(/\s+/g, ' ').trim();
    if ((!rawText || rawText.length < MIN_READABLE_CHARS) && contentTypeHeader.includes('text/plain')) {
      rawText = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (!rawText || rawText.length < MIN_READABLE_CHARS) {
      return null;
    }

    const excerpt = clipAtBoundary(rawText, maxChars);
    const words = excerpt.split(/\s+/).filter(Boolean);
    const domain = parsedUrl.hostname.replace(/^www\./i, '');
    const title = String(article?.title || fallbackTitle || domain).replace(/\s+/g, ' ').trim();
    const siteName = String(article?.siteName || domain).replace(/\s+/g, ' ').trim();

    return {
      url: parsedUrl.toString(),
      title: title || domain,
      domain,
      siteName: siteName || domain,
      excerpt,
      wordCount: words.length,
      charCount: excerpt.length
    };
  } catch (_) {
    // Qualquer erro de rede, timeout, TLS ou DOM faz a página ser ignorada com segurança
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

const MIN_SNIPPET_FALLBACK_CHARS = 90;

/**
 * Constrói uma fonte verificada a partir do snippet rico da SERP quando o site bloqueia
 * o scraper direto (ex.: Cloudflare/403), garantindo que resumos ricos não sejam perdidos.
 */
function buildSnippetFallbackSource(item, maxChars = DEFAULT_MAX_CHARS) {
  if (!item || typeof item.url !== 'string') return null;
  const rawDesc = String(item.description || item.content || '').replace(/\s+/g, ' ').trim();
  if (rawDesc.length < MIN_SNIPPET_FALLBACK_CHARS) return null;

  try {
    const parsedUrl = new URL(item.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    const domain = parsedUrl.hostname.replace(/^www\./i, '');
    const title = String(item.title || domain).replace(/\s+/g, ' ').trim();
    const excerpt = clipAtBoundary(rawDesc, maxChars);
    const words = excerpt.split(/\s+/).filter(Boolean);
    return {
      url: parsedUrl.toString(),
      title: title || domain,
      domain,
      siteName: domain,
      excerpt,
      wordCount: words.length,
      charCount: excerpt.length,
      isSerpSnippet: true
    };
  } catch (_) {
    return null;
  }
}

/**
 * Extrai em paralelo os até 6 resultados retornados pela busca.
 * - Aplica Early-Cutoff (estilo Perplexity/Kagi): assim que `earlyCutoffCount` (padrão 4)
 *   páginas são extraídas com sucesso, concede uma janela máxima (`gracePeriodMs`, padrão 1200ms)
 *   para as restantes e aborta conexões lentas para liberar o LLM imediatamente.
 * - Se o download DOM falhar mas o item possuir um snippet SERP rico (>= 90 chars),
 *   utiliza o snippet verificado como fallback (salvo se `allowSnippetFallback === false`).
 * - Renumera sequencialmente ([1], [2], ...) APENAS as fontes obtidas com sucesso.
 */
async function extractTopSources(searchResults = [], options = {}) {
  const candidates = Array.isArray(searchResults) ? searchResults.slice(0, 6) : [];
  if (candidates.length === 0) {
    return {
      sources: [],
      attemptedCount: 0,
      succeededCount: 0,
      skippedUrls: []
    };
  }

  const earlyCutoffCount = Number(options.earlyCutoffCount ?? 4);
  const gracePeriodMs = Number(options.gracePeriodMs ?? 1200);
  const allowSnippetFallback = options.allowSnippetFallback !== false;
  const maxChars = Number(options.maxChars || process.env.MAX_CHARS_PER_SOURCE || DEFAULT_MAX_CHARS);

  const cutoffController = new AbortController();
  const externalSignal = options.signal || null;
  const onExternalAbort = () => cutoffController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) cutoffController.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let fastSuccessCount = 0;
  let graceTimer = null;

  const tasks = candidates.map(async (item) => {
    const pageResult = await extractReadablePage(item.url, item.title, {
      ...options,
      signal: cutoffController.signal
    });

    if (pageResult && pageResult.excerpt) {
      fastSuccessCount += 1;
      if (fastSuccessCount >= earlyCutoffCount && !graceTimer && gracePeriodMs > 0) {
        graceTimer = setTimeout(() => {
          cutoffController.abort();
        }, gracePeriodMs);
      }
      return pageResult;
    }

    if (allowSnippetFallback) {
      return buildSnippetFallbackSource(item, maxChars);
    }
    return null;
  });

  const settled = await Promise.allSettled(tasks);
  if (graceTimer) clearTimeout(graceTimer);
  if (externalSignal) {
    externalSignal.removeEventListener('abort', onExternalAbort);
  }

  const sources = [];
  const skippedUrls = [];

  settled.forEach((outcome, index) => {
    const candidateUrl = candidates[index]?.url || '';
    if (outcome.status === 'fulfilled' && outcome.value && outcome.value.excerpt) {
      sources.push({
        citationIndex: sources.length + 1,
        ...outcome.value
      });
    } else if (candidateUrl) {
      skippedUrls.push(candidateUrl);
    }
  });

  return {
    sources,
    attemptedCount: candidates.length,
    succeededCount: sources.length,
    skippedUrls
  };
}

async function readBodyWithLimit(body, maxBytes) {
  if (!body) return '';
  if (typeof body.text === 'function' && typeof body[Symbol.asyncIterator] !== 'function') {
    const text = await body.text();
    return text.slice(0, maxBytes);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      const allowed = buf.subarray(0, Math.max(0, buf.length - (totalBytes - maxBytes)));
      if (allowed.length > 0) chunks.push(allowed);
      break;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function clipAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastPeriod = Math.max(sliced.lastIndexOf('. '), sliced.lastIndexOf('! '), sliced.lastIndexOf('? '));
  if (lastPeriod > maxChars * 0.7) {
    return sliced.slice(0, lastPeriod + 1).trim();
  }
  const lastSpace = sliced.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.8) {
    return `${sliced.slice(0, lastSpace).trim()}…`;
  }
  return `${sliced.trim()}…`;
}

module.exports = {
  extractReadablePage,
  extractTopSources,
  buildSnippetFallbackSource
};
