'use strict';

const dns = require('node:dns');
const net = require('node:net');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

const { request } = require('undici');
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const {
  assertSafeOutboundUrl,
  createSafeHttpDispatcher,
  isPrivateOrReservedIp
} = require('./security');
const { tokenizeText } = require('./search/reranker');

const DEFAULT_TIMEOUT_MS = 5200;
const DEFAULT_MAX_CHARS = 5500;
const DEFAULT_QUERY_FOCUSED_MAX_CHARS = 2400;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB limite de segurança para parsing DOM
const MIN_READABLE_CHARS = 80;
const MIN_SNIPPET_FALLBACK_CHARS = 90;
const MAX_REDIRECT_HOPS = 3;

const FORBIDDEN_HOSTNAMES_LOCAL = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'host.docker.internal',
  'gateway.docker.internal',
  'metadata.google.internal',
  'metadata',
  'instance-data'
]);

const FORBIDDEN_SUFFIXES_LOCAL = ['.localhost', '.local', '.internal', '.localdomain'];

// Dispatcher seguro dedicado com TLS estrito (rejectUnauthorized: true) + anti-DNS Rebinding
const safeExtractorDispatcher = createSafeHttpDispatcher({
  timeout: 6500,
  headersTimeout: DEFAULT_TIMEOUT_MS,
  bodyTimeout: DEFAULT_TIMEOUT_MS
});

function createSsrfError(msg) {
  const err = new Error(msg);
  err.code = 'ERR_SSRF_BLOCKED';
  return err;
}

/**
 * Valida segurança SSRF de uma URL de saída (URL inicial e cada hop de redirect).
 * - Em produção (`isRealNetwork && !allowPrivateForTests`): valida integralmente via `assertSafeOutboundUrl`
 *   incluindo resolução DNS de todos os registros A/AAAA e bloqueio de IPs privados/loopback/metadata.
 * - Com mock injetado (`!isRealNetwork && !allowPrivateForTests`): ainda bloqueia protocolos perigosos,
 *   credenciais, hostnames internos e IPs literais privados/loopback, pulando apenas DNS externo
 *   para hostnames fictícios de teste (ex.: `fonte1.dev`, `fast1.dev`).
 */
async function validateOutboundTarget(rawUrl, { isRealNetwork = true, allowPrivateForTests = false, signal = null } = {}) {
  const str = String(rawUrl || '').trim();
  if (!str || /[\u0000-\u001f\u007f]/.test(str)) {
    throw createSsrfError('URL inválida ou com caracteres de controle.');
  }

  let parsed;
  try {
    parsed = new URL(str);
  } catch (_) {
    throw createSsrfError('URL malformada.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createSsrfError(`Protocolo bloqueado: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw createSsrfError('Credenciais embutidas na URL são proibidas.');
  }

  if (allowPrivateForTests) {
    return parsed.toString();
  }

  const hostname = parsed.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!hostname) {
    throw createSsrfError('Hostname vazio.');
  }

  if (
    FORBIDDEN_HOSTNAMES_LOCAL.has(hostname) ||
    FORBIDDEN_SUFFIXES_LOCAL.some((s) => hostname.endsWith(s))
  ) {
    throw createSsrfError(`Hostname interno/reservado bloqueado: ${hostname}`);
  }

  if (net.isIP(hostname) !== 0 && isPrivateOrReservedIp(hostname)) {
    throw createSsrfError(`IP privado/reservado bloqueado: ${hostname}`);
  }

  if (isRealNetwork) {
    const validated = await assertSafeOutboundUrl(parsed.toString(), { signal });
    return validated.url;
  }

  return parsed.toString();
}

function isAllowedContentType(contentTypeHeader) {
  const ct = String(contentTypeHeader || '').trim().toLowerCase();
  // Exige Content-Type explícito! Rejeita respostas sem Content-Type ou binários.
  if (!ct) return false;
  return (
    ct.includes('text/html') ||
    ct.includes('application/xhtml+xml') ||
    ct.includes('text/plain')
  );
}

function extractCharsetFromContentType(contentTypeHeader) {
  const match = String(contentTypeHeader || '').match(/charset\s*=\s*["']?([a-zA-Z0-9._-]+)["']?/i);
  return match ? match[1].trim().toLowerCase() : '';
}

function sniffCharsetFromHtmlBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  const headAscii = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('latin1');
  const metaCharset = headAscii.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i);
  if (metaCharset && metaCharset[1]) {
    return metaCharset[1].trim().toLowerCase();
  }
  const metaHttpEquiv = headAscii.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i);
  if (metaHttpEquiv && metaHttpEquiv[1]) {
    return metaHttpEquiv[1].trim().toLowerCase();
  }
  return '';
}

function decodeBufferWithCharset(buffer, contentTypeHeader = '') {
  const declared = extractCharsetFromContentType(contentTypeHeader) || sniffCharsetFromHtmlBytes(buffer) || 'utf-8';
  const normalizedCharset = declared === 'utf8' ? 'utf-8' : declared;
  try {
    return new TextDecoder(normalizedCharset, { fatal: false }).decode(buffer);
  } catch (_) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

/**
 * Lê o corpo HTTP até `maxBytes`, destruindo imediatamente o stream (`body.destroy()`)
 * ao exceder o limite para evitar exaustão de memória/sockets, e decodifica com `TextDecoder`.
 */
async function readBodyWithLimit(body, maxBytes = MAX_HTML_BYTES, contentTypeHeader = '') {
  if (!body) return '';
  if (typeof body.text === 'function' && typeof body[Symbol.asyncIterator] !== 'function') {
    const text = await body.text();
    return text.slice(0, maxBytes);
  }

  const chunks = [];
  let totalBytes = 0;
  let exceeded = false;

  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      const allowed = buf.subarray(0, Math.max(0, buf.length - (totalBytes - maxBytes)));
      if (allowed.length > 0) chunks.push(allowed);
      exceeded = true;
      break;
    }
    chunks.push(buf);
  }

  if (exceeded) {
    try {
      if (typeof body.destroy === 'function') {
        body.destroy();
      } else if (typeof body.cancel === 'function') {
        await body.cancel();
      }
    } catch (_) {}
  }

  const fullBuffer = Buffer.concat(chunks);
  return decodeBufferWithCharset(fullBuffer, contentTypeHeader);
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

/**
 * Extrai blocos estruturados (cabeçalhos + parágrafos/chunks de ~450 chars) do HTML limpo do Readability
 * ou de texto plano para seleção focada na consulta.
 */
function buildStructuredPassages(articleHtml, fallbackPlainText, targetChunkChars = 450) {
  const chunks = [];

  const pushSplitParagraph = (text, heading = '') => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 30) return;

    if (clean.length <= targetChunkChars + 140) {
      chunks.push({ index: chunks.length, heading, text: clean });
      return;
    }

    // Divide parágrafos muito longos em sentenças de ~targetChunkChars
    const sentences = clean.split(/(?<=[.!?。！？])\s+/);
    let current = '';
    for (const sent of sentences) {
      if (current && current.length + sent.length + 1 > targetChunkChars) {
        chunks.push({ index: chunks.length, heading, text: current.trim() });
        current = sent;
      } else {
        current = current ? `${current} ${sent}` : sent;
      }
    }
    if (current.trim().length >= 25) {
      chunks.push({ index: chunks.length, heading, text: current.trim() });
    }
  };

  if (articleHtml && typeof articleHtml === 'string') {
    try {
      const { document } = parseHTML(`<div>${articleHtml}</div>`);
      const nodes = [...document.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre')];
      let currentHeading = '';
      for (const node of nodes) {
        const tag = String(node.tagName || '').toLowerCase();
        const txt = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
          currentHeading = txt.slice(0, 140);
          continue;
        }
        pushSplitParagraph(txt, currentHeading);
      }
    } catch (_) {}
  }

  if (chunks.length === 0 && fallbackPlainText) {
    const rawParas = String(fallbackPlainText).split(/\n{2,}/);
    for (const para of rawParas) {
      pushSplitParagraph(para, '');
    }
  }

  return chunks;
}

/**
 * Query-Focused Passage Selection:
 * Quando o texto extraído excede `maxChars` e há uma `query`, pontua cada chunk (~450 chars)
 * com BM25 + posição do lead + aderência do cabeçalho da seção e remonta os trechos de maior
 * sinal preservando a ordem natural do documento e cabeçalhos.
 */
function selectQueryFocusedPassages(articleHtmlOrText, query = '', maxChars = DEFAULT_QUERY_FOCUSED_MAX_CHARS, fallbackPlainText = '') {
  const plainText = String(fallbackPlainText || (typeof articleHtmlOrText === 'string' && !/<[a-z][\s\S]*>/i.test(articleHtmlOrText) ? articleHtmlOrText : '')).replace(/\s+/g, ' ').trim();
  if (!query || (plainText && plainText.length <= maxChars)) {
    return clipAtBoundary(plainText || String(articleHtmlOrText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), maxChars);
  }

  const isHtml = typeof articleHtmlOrText === 'string' && /<[a-z][\s\S]*>/i.test(articleHtmlOrText);
  const chunks = buildStructuredPassages(isHtml ? articleHtmlOrText : '', plainText || String(articleHtmlOrText || ''), 450);

  if (chunks.length <= 1) {
    const single = chunks[0]?.text || plainText;
    return clipAtBoundary(single, maxChars);
  }

  const queryTerms = [...new Set(tokenizeText(query))];
  if (queryTerms.length === 0) {
    return clipAtBoundary(plainText || chunks.map((c) => c.text).join(' '), maxChars);
  }

  // Okapi BM25 nos chunks do documento
  const N = chunks.length;
  const chunkTokensList = chunks.map((c) => {
    const bodyToks = tokenizeText(c.text);
    const headToks = tokenizeText(c.heading);
    const tf = new Map();
    for (const t of bodyToks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of headToks) tf.set(t, (tf.get(t) || 0) + 2.0);
    return { tf, len: bodyToks.length + headToks.length * 2 || 1, headSet: new Set(headToks) };
  });

  const avgdl = chunkTokensList.reduce((acc, d) => acc + d.len, 0) / N || 1;
  const df = new Map();
  for (const qt of queryTerms) {
    let count = 0;
    for (const d of chunkTokensList) {
      if (d.tf.has(qt)) {
        count += 1;
      } else if (qt.length >= 5) {
        const stem = qt.slice(0, qt.length - 2);
        for (const k of d.tf.keys()) {
          if (k.startsWith(stem)) {
            count += 1;
            break;
          }
        }
      }
    }
    df.set(qt, count);
  }

  const k1 = 1.5;
  const b = 0.75;

  const scoredChunks = chunks.map((c, idx) => {
    const d = chunkTokensList[idx];
    let bm25 = 0;
    let matchedCount = 0;
    let headingHit = false;

    for (const qt of queryTerms) {
      let f = d.tf.get(qt) || 0;
      if (f === 0 && qt.length >= 5) {
        const stem = qt.slice(0, qt.length - 2);
        for (const [k, val] of d.tf.entries()) {
          if (k.startsWith(stem)) f += val * 0.7;
        }
      }
      if (f <= 0) continue;
      matchedCount += 1;
      if (d.headSet.has(qt)) headingHit = true;
      const idf = Math.log(1 + (N - (df.get(qt) || 0) + 0.5) / ((df.get(qt) || 0) + 0.5));
      bm25 += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / avgdl))));
    }

    const leadBonus = idx === 0 ? 0.35 : (idx === 1 ? 0.15 : 0);
    const headingBonus = headingHit ? 0.3 : 0;
    return {
      ...c,
      score: bm25 + leadBonus + headingBonus,
      matchedCount
    };
  });

  const anyLexicalMatch = scoredChunks.some((c) => c.matchedCount > 0);
  if (!anyLexicalMatch) {
    return clipAtBoundary(plainText || chunks.map((c) => c.text).join(' '), maxChars);
  }

  // Seleciona os melhores chunks por score até o orçamento `maxChars`
  const ranked = [...scoredChunks].sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const picked = [];
  let usedChars = 0;
  const seenHeadings = new Set();

  for (const cand of ranked) {
    const headingCost = cand.heading && !seenHeadings.has(cand.heading) ? cand.heading.length + 6 : 0;
    const itemCost = cand.text.length + headingCost + (picked.length > 0 ? 4 : 0);
    if (usedChars + itemCost > maxChars) {
      if (picked.length === 0) {
        picked.push(cand);
        usedChars = maxChars;
      }
      continue;
    }
    picked.push(cand);
    if (cand.heading) seenHeadings.add(cand.heading);
    usedChars += itemCost;
    if (usedChars >= maxChars * 0.92) break;
  }

  // Restaura ordem natural do documento e preserva cabeçalhos
  picked.sort((a, b) => a.index - b.index);
  const segments = [];
  let lastHeading = '';
  let prevIdx = -1;

  for (const p of picked) {
    const prefixGap = prevIdx !== -1 && p.index > prevIdx + 1 ? ' [...] ' : '';
    let blockText = p.text;
    if (p.heading && p.heading !== lastHeading) {
      blockText = `[${p.heading}] ${blockText}`;
      lastHeading = p.heading;
    }
    segments.push(`${prefixGap}${blockText}`);
    prevIdx = p.index;
  }

  return clipAtBoundary(segments.join(' ').replace(/\s+/g, ' ').trim(), maxChars);
}

/**
 * Baixa uma página web com segurança estrita (SSRF + TLS rejectUnauthorized: true + validação de cada redirect),
 * decodifica charset via TextDecoder, usa linkedom + @mozilla/readability e aplica Query-Focused Passage Selection.
 */
async function extractReadablePage(targetUrl, fallbackTitle = '', options = {}) {
  const httpRequest = options.requestFn || request;
  const isRealNetwork = httpRequest === request;
  const allowPrivateForTests = Boolean(options.allowPrivateForTests);
  const timeoutMs = Number(options.timeoutMs || process.env.PAGE_FETCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const query = String(options.query || '').trim();

  const explicitMaxChars = options.maxChars ?? options.maxCharsPerSource;
  const maxChars = Number(
    explicitMaxChars ||
    (query ? DEFAULT_QUERY_FOCUSED_MAX_CHARS : (process.env.MAX_CHARS_PER_SOURCE || DEFAULT_MAX_CHARS))
  );

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

  const reqDispatcherOpts = isRealNetwork && !allowPrivateForTests
    ? { dispatcher: safeExtractorDispatcher }
    : {};

  try {
    // Validação SSRF obrigatória da URL inicial ANTES de qualquer I/O de rede
    const safeInitialUrl = await validateOutboundTarget(targetUrl, {
      isRealNetwork,
      allowPrivateForTests,
      signal: controller.signal
    });
    const parsedInitialUrl = new URL(safeInitialUrl);

    // Fast-path para repositórios do GitHub: extrai README.md via raw.githubusercontent.com (validado por SSRF)
    const ghRepoMatch =
      parsedInitialUrl.hostname.replace(/^www\./i, '').toLowerCase() === 'github.com' &&
      parsedInitialUrl.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);

    if (ghRepoMatch && !/^(topics|search|explore|orgs|users|settings|marketplace|pulls|issues)$/i.test(ghRepoMatch[1])) {
      const owner = ghRepoMatch[1];
      const repoClean = ghRepoMatch[2].replace(/\.git$/i, '');
      const rawReadmeUrl = `https://raw.githubusercontent.com/${owner}/${repoClean}/HEAD/README.md`;
      try {
        const safeReadmeUrl = await validateOutboundTarget(rawReadmeUrl, {
          isRealNetwork,
          allowPrivateForTests,
          signal: controller.signal
        });
        const readmeRes = await httpRequest(safeReadmeUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'DeepEvil/1.0 (Global Research Engine)' },
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: controller.signal,
          ...reqDispatcherOpts
        });
        if (readmeRes && readmeRes.statusCode >= 200 && readmeRes.statusCode < 300) {
          const ct = String(readmeRes.headers?.['content-type'] || readmeRes.headers?.['Content-Type'] || 'text/plain; charset=utf-8');
          const mdBody = await readBodyWithLimit(readmeRes.body, MAX_HTML_BYTES, ct);
          const cleanedMd = String(mdBody || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (cleanedMd.length >= MIN_READABLE_CHARS) {
            const excerpt = query
              ? selectQueryFocusedPassages(mdBody, query, maxChars, cleanedMd)
              : clipAtBoundary(cleanedMd, maxChars);
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
        // Continua para extração HTML padrão
      }
    }

    let currentUrl = safeInitialUrl;
    let response = null;

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      // Revalida SSRF antes de cada hop de rede (proteção contra redirect para 127.0.0.1 / 169.254.169.254)
      currentUrl = await validateOutboundTarget(currentUrl, {
        isRealNetwork,
        allowPrivateForTests,
        signal: controller.signal
      });

      response = await httpRequest(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.7,pt;q=0.6,*;q=0.5'
        },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: controller.signal,
        ...reqDispatcherOpts
      });

      if (response && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers?.location || response.headers?.Location;
        if (response.body && typeof response.body.dump === 'function') {
          await response.body.dump().catch(() => {});
        }
        if (!location || hop === MAX_REDIRECT_HOPS) {
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
    ).trim();

    // Exige Content-Type explícito e textual (rejeita respostas sem Content-Type ou binárias)
    if (!isAllowedContentType(contentTypeHeader)) {
      if (response?.body && typeof response.body.dump === 'function') {
        await response.body.dump().catch(() => {});
      }
      return null;
    }

    const html = await readBodyWithLimit(response.body, MAX_HTML_BYTES, contentTypeHeader);
    if (!html || html.trim().length < MIN_READABLE_CHARS) {
      return null;
    }

    // URL canônica pós-redirect (nunca a URL original antes de 3xx!)
    const finalParsedUrl = new URL(currentUrl);
    const domain = finalParsedUrl.hostname.replace(/^www\./i, '');

    const { document: doc } = parseHTML(html);
    try {
      Object.defineProperty(doc, 'baseURI', { value: currentUrl, configurable: true });
    } catch (_) {}

    doc.querySelectorAll('script, style, noscript, iframe, svg, canvas, form, nav, footer').forEach((el) => {
      el.remove();
    });

    const reader = new Readability(doc);
    const article = reader.parse();

    let rawText = String(article?.textContent || '').replace(/\s+/g, ' ').trim();
    if ((!rawText || rawText.length < MIN_READABLE_CHARS) && contentTypeHeader.toLowerCase().includes('text/plain')) {
      rawText = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (!rawText || rawText.length < MIN_READABLE_CHARS) {
      return null;
    }

    const articleTitleCheck = String(article?.title || doc.title || '').trim();
    if (
      /^(client\s+challenge|just\s+a\s+moment|attention\s+required|access\s+denied|security\s+check|ddos-guard|verifying\s+you\s+are\s+human)/i.test(articleTitleCheck) ||
      /\b(enable\s+javascript\s+and\s+cookies\s+to\s+continue|checking\s+if\s+the\s+site\s+connection\s+is\s+secure)\b/i.test(rawText)
    ) {
      return null;
    }

    const excerpt = query && rawText.length > maxChars
      ? selectQueryFocusedPassages(article?.content || rawText, query, maxChars, rawText)
      : clipAtBoundary(rawText, maxChars);

    const words = excerpt.split(/\s+/).filter(Boolean);
    const poleMatch = String(fallbackTitle || '').match(/^(\[(?:🇺🇸|🇨🇳|🇩🇪|🇯🇵|🇰🇷|🇷🇺|🇧🇷|🌍)[^\]]+\])\s*/);
    const yandexSuffixMatch = String(fallbackTitle || '').match(/(\s+—\s+Yandex(?:\s+Search|\s*\/\/\s*CyberLeninka)?)$/);
    const extractedCandidate = String(article?.title || '').replace(/\s+/g, ' ').trim();
    const rawExtractedTitle = (extractedCandidate.length >= 15 ? extractedCandidate : String(fallbackTitle || extractedCandidate || domain)).replace(/\s+/g, ' ').trim();
    const baseTitle = poleMatch && !rawExtractedTitle.startsWith('[')
      ? `${poleMatch[1]} ${rawExtractedTitle}`
      : rawExtractedTitle;
    const title = yandexSuffixMatch && !/Yandex/i.test(baseTitle)
      ? `${baseTitle}${yandexSuffixMatch[1]}`
      : baseTitle;
    const siteName = String(article?.siteName || domain).replace(/\s+/g, ' ').trim();

    return {
      url: currentUrl,
      title: title || domain,
      domain,
      siteName: siteName || domain,
      excerpt,
      wordCount: words.length,
      charCount: excerpt.length
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Constrói uma fonte verificada a partir do snippet rico da SERP quando o site bloqueia
 * o scraper direto (ex.: Cloudflare/403), recusando URLs inválidas/privadas.
 */
function buildSnippetFallbackSource(item, maxChars = DEFAULT_MAX_CHARS) {
  if (!item || typeof item.url !== 'string') return null;
  const rawDesc = String(item.description || item.content || '').replace(/\s+/g, ' ').trim();
  if (rawDesc.length < MIN_SNIPPET_FALLBACK_CHARS) return null;

  try {
    const parsedUrl = new URL(item.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
    const host = parsedUrl.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (
      !host ||
      FORBIDDEN_HOSTNAMES_LOCAL.has(host) ||
      FORBIDDEN_SUFFIXES_LOCAL.some((s) => host.endsWith(s)) ||
      (net.isIP(host) !== 0 && isPrivateOrReservedIp(host))
    ) {
      return null;
    }
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
 * Extrai em paralelo as fontes retornadas pela busca com Early-Cutoff dinâmico corrigido
 * (calculado sobre candidatos vivos/restantes para que 3 falhas nunca desabilitem o cutoff)
 * + SERP Snippet Fallback + Query-Focused Passage Selection.
 */
async function extractTopSources(searchResults = [], options = {}) {
  const maxSources = Number(options.maxSources || 12);
  const candidates = Array.isArray(searchResults) ? searchResults.slice(0, maxSources) : [];
  if (candidates.length === 0) {
    return {
      sources: [],
      attemptedCount: 0,
      succeededCount: 0,
      skippedUrls: []
    };
  }

  const explicitCutoff = options.earlyCutoffCount !== undefined && options.earlyCutoffCount !== null
    ? Number(options.earlyCutoffCount)
    : null;
  const gracePeriodMs = Number(options.gracePeriodMs ?? 650);
  const allowSnippetFallback = options.allowSnippetFallback !== false;
  const query = String(options.query || '').trim();
  const maxChars = Number(
    options.maxChars ||
    options.maxCharsPerSource ||
    (query ? DEFAULT_QUERY_FOCUSED_MAX_CHARS : (process.env.MAX_CHARS_PER_SOURCE || DEFAULT_MAX_CHARS))
  );

  const cutoffController = new AbortController();
  const externalSignal = options.signal || null;
  const onExternalAbort = () => cutoffController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) cutoffController.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let fastSuccessCount = 0;
  let failedCount = 0;
  let graceTimer = null;

  const checkEarlyCutoff = () => {
    if (graceTimer || gracePeriodMs <= 0) return;
    const remainingLive = Math.max(0, candidates.length - failedCount);
    const targetCutoff = explicitCutoff !== null
      ? explicitCutoff
      : Math.min(remainingLive, Math.min(Math.max(4, Math.ceil(remainingLive * 0.5)), 6));

    if (targetCutoff > 0 && fastSuccessCount >= targetCutoff) {
      graceTimer = setTimeout(() => {
        cutoffController.abort();
      }, gracePeriodMs);
    }
  };

  const tasks = candidates.map(async (item) => {
    const pageResult = await extractReadablePage(item.url, item.title, {
      ...options,
      query,
      maxChars,
      signal: cutoffController.signal
    });

    if (pageResult && pageResult.excerpt) {
      fastSuccessCount += 1;
      checkEarlyCutoff();
      return pageResult;
    }

    failedCount += 1;
    checkEarlyCutoff();

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

module.exports = {
  extractReadablePage,
  extractTopSources,
  buildSnippetFallbackSource,
  selectQueryFocusedPassages,
  readBodyWithLimit
};
