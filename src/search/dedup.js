'use strict';

const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'yclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  'spm',
  'ved',
  'usg',
  'ref',
  'ref_src',
  'ref_url',
  'feature',
  'oc',
  'guccounter',
  'guce_referrer',
  'guce_referrer_sig',
  's_cid',
  'trk',
  'trkcampaign'
]);

const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

function transliterateCyrillicBasic(text) {
  let out = '';
  for (const ch of String(text || '').toLowerCase()) {
    out += Object.prototype.hasOwnProperty.call(CYRILLIC_TO_LATIN, ch) ? CYRILLIC_TO_LATIN[ch] : ch;
  }
  return out;
}

/**
 * Produz URL limpa (removendo parâmetros de tracking e `.m.wikipedia.org`) e chave canônica
 * determinística para deduplicação (host lowercase sem `www.`, sem trailing slash e sem fragmento).
 */
function canonicalizeUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  if (!str) return null;

  let parsed;
  try {
    parsed = new URL(str);
  } catch (_) {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.hostname.endsWith('.m.wikipedia.org')) {
    parsed.hostname = parsed.hostname.replace('.m.wikipedia.org', '.wikipedia.org');
  }

  // Remove parâmetros de tracking da URL pública
  const cleanParams = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(lk)) {
      continue;
    }
    cleanParams.push([k, v]);
  }

  const displayUrlObj = new URL(parsed.toString());
  displayUrlObj.hash = '';
  displayUrlObj.search = '';
  for (const [k, v] of cleanParams) {
    displayUrlObj.searchParams.append(k, v);
  }

  // Chave canônica (sem www., sem trailing slash, query params ordenados)
  const keyHost = parsed.hostname.replace(/^www\./i, '');
  const keyPath = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
  const sortedParams = [...cleanParams].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const keySearch = sortedParams.length > 0
    ? `?${sortedParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';

  return {
    url: displayUrlObj.toString(),
    canonicalKey: `${keyHost}${keyPath.toLowerCase()}${keySearch}`,
    domain: keyHost
  };
}

/**
 * Normaliza slug ou título de entidade para detectar duplicatas cross-lingual
 * (ex.: `Hugging_Face`, `Hugging Face`, `UVB-76`, `УВБ-76`).
 */
function normalizeEntitySlug(rawSlug) {
  let decoded = String(rawSlug || '').trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch (_) {}

  // Remove prefixo de badge geopolítico e sufixo "— Wikipedia (XX)"
  decoded = decoded
    .replace(/^\[(?:🇺🇸|🇨🇳|🇩🇪|🇯🇵|🇰🇷|🇷🇺|🇧🇷|🌍)[^\]]+\]\s*/, '')
    .replace(/\s+[—–-]\s+Wikipedia\s*\([A-Z]{2}\)\s*$/i, '')
    .replace(/\s*\([^)]{1,35}\)\s*$/, '') // remove desambiguação "(company)", "(algorithm)"
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .trim();

  if (!decoded) return '';

  // Se contiver caracteres cirílicos, translitera para detectar ex.: УВБ-76 === UVB-76
  const hasCyrillic = /[\u0400-\u04ff]/.test(decoded);
  const base = hasCyrillic ? transliterateCyrillicBasic(decoded) : decoded.toLowerCase();

  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_./:-]+/g, '')
    .trim();
}

/**
 * Extrai metadados de páginas da Wikipedia (idioma, slug normalizado, QID Wikidata).
 */
function extractWikipediaMeta(item, parsedDomain = '') {
  if (!item || !item.url) return null;
  let parsed;
  try {
    parsed = new URL(item.url);
  } catch (_) {
    return null;
  }
  const host = (parsedDomain || parsed.hostname.replace(/^www\./i, '')).toLowerCase();
  const wikiMatch = host.match(/^([a-z]{2,3})\.wikipedia\.org$/);
  if (!wikiMatch) return null;

  const lang = wikiMatch[1];
  const rawSlug = parsed.pathname.replace(/^\/wiki\//i, '').replace(/\/+$/, '');
  const normalizedSlug = normalizeEntitySlug(rawSlug || item.title || '');
  const wikidataId = String(item.wikidataId || item.qid || '').trim().toUpperCase();
  const canonicalEntity = item.canonicalEntity ? normalizeEntitySlug(item.canonicalEntity) : '';

  let entityKey = '';
  if (/^Q\d+$/.test(wikidataId)) {
    entityKey = `wiki:qid:${wikidataId}`;
  } else if (canonicalEntity) {
    entityKey = `wiki:entity:${canonicalEntity}`;
  } else if (normalizedSlug) {
    entityKey = `wiki:slug:${normalizedSlug}`;
  } else {
    entityKey = `wiki:url:${host}${parsed.pathname.toLowerCase()}`;
  }

  return {
    isWikipedia: true,
    lang,
    rawSlug,
    normalizedSlug,
    wikidataId: /^Q\d+$/.test(wikidataId) ? wikidataId : null,
    entityKey
  };
}

function normalizeTitleFingerprint(title) {
  return String(title || '')
    .replace(/^\[(?:🇺🇸|🇨🇳|🇩🇪|🇯🇵|🇰🇷|🇷🇺|🇧🇷|🌍)[^\]]+\]\s*/, '')
    .replace(/\s+[—–|-]\s+[^—–|-]{2,45}$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeWikiPreferenceScore(item, wikiMeta, preferredLang = 'en') {
  let score = 0;
  if (wikiMeta.lang === 'en') score += 35;
  if (wikiMeta.lang === preferredLang) score += 30;
  const descLen = String(item.description || item.content || '').trim().length;
  score += Math.min(descLen / 12, 30);
  if (wikiMeta.wikidataId) score += 5;
  if (typeof item.score === 'number') score += item.score * 10;
  return score;
}

function mergeCandidateMetadata(primary, secondary) {
  const engines = new Set();
  for (const src of [primary, secondary]) {
    if (Array.isArray(src.engines)) src.engines.forEach((e) => engines.add(e));
    if (src.engine) engines.add(src.engine);
  }
  const engineRanks = { ...(secondary.engineRanks || {}), ...(primary.engineRanks || {}) };
  if (primary.engine && Number.isFinite(primary.engineRank)) {
    engineRanks[primary.engine] = Math.min(engineRanks[primary.engine] ?? Infinity, primary.engineRank);
  }
  if (secondary.engine && Number.isFinite(secondary.engineRank)) {
    engineRanks[secondary.engine] = Math.min(engineRanks[secondary.engine] ?? Infinity, secondary.engineRank);
  }

  const primaryDesc = String(primary.description || primary.content || '').trim();
  const secondaryDesc = String(secondary.description || secondary.content || '').trim();
  const bestDesc = secondaryDesc.length > primaryDesc.length + 25 ? secondaryDesc : (primaryDesc || secondaryDesc);

  return {
    ...primary,
    description: bestDesc,
    wikidataId: primary.wikidataId || secondary.wikidataId || undefined,
    canonicalEntity: primary.canonicalEntity || secondary.canonicalEntity || undefined,
    engines: [...engines],
    engineRanks
  };
}

/**
 * Deduplica resultados por:
 * 1. URL Canônica (strip tracking params, trailing slash, host lowercase) fundindo sinais de múltiplos motores (para RRF)
 * 2. Cross-Lingual Wikipedia & Entity Dedup (mantém NO MÁXIMO 1 artigo Wikipedia por entidade via QID/slug/canonicalEntity)
 * 3. Títulos de notícias espelhadas quase idênticos (Google News / syndication)
 * 4. Cap de domínio (máximo `maxPerDomain = 2` por domínio, exceto `github.com` em `intent === 'code_repo'`)
 */
function deduplicateResults(rawItems = [], options = {}) {
  const searchLang = String(options.searchLang || 'pt-BR').toLowerCase();
  const preferredWikiLang = searchLang.startsWith('pt') ? 'pt' : searchLang.slice(0, 2);
  const intent = String(options.intent || 'deep_research').toLowerCase();
  const maxPerDomain = Number.isFinite(Number(options.maxPerDomain)) ? Number(options.maxPerDomain) : 2;
  const crossLingualWikiDedup = options.crossLingualWikiDedup !== false;
  const maxTotalWiki = Number.isFinite(Number(options.maxTotalWiki))
    ? Number(options.maxTotalWiki)
    : (intent === 'breaking_news' ? 1 : Infinity);

  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

  // Passo 1: Canonical URL dedup + fusão de metadados de motores
  const byCanonicalUrl = new Map();
  const orderedUrlKeys = [];

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    if (!raw || typeof raw.url !== 'string') continue;
    const canon = canonicalizeUrl(raw.url);
    if (!canon) continue;

    const normalized = {
      ...raw,
      url: canon.url,
      canonicalKey: canon.canonicalKey,
      domain: raw.domain || canon.domain,
      title: String(raw.title || canon.domain).replace(/\s+/g, ' ').trim(),
      description: String(raw.description || raw.content || '').replace(/\s+/g, ' ').trim(),
      engines: Array.isArray(raw.engines) ? [...raw.engines] : (raw.engine ? [raw.engine] : []),
      engineRanks: {
        ...(raw.engineRanks || {}),
        ...(raw.engine && Number.isFinite(raw.engineRank) ? { [raw.engine]: raw.engineRank } : {})
      },
      _origIdx: Number.isFinite(raw._origIdx) ? raw._origIdx : i
    };

    if (byCanonicalUrl.has(canon.canonicalKey)) {
      const existing = byCanonicalUrl.get(canon.canonicalKey);
      byCanonicalUrl.set(canon.canonicalKey, mergeCandidateMetadata(existing, normalized));
    } else {
      byCanonicalUrl.set(canon.canonicalKey, normalized);
      orderedUrlKeys.push(canon.canonicalKey);
    }
  }

  // Passo 2: Cross-Lingual Wikipedia & Entity Dedup (máx 1 Wikipedia por entidade)
  const wikiGroups = new Map();
  const nonWikiOrBestList = [];

  for (const key of orderedUrlKeys) {
    const item = byCanonicalUrl.get(key);
    const wikiMeta = extractWikipediaMeta(item, item.domain);

    if (crossLingualWikiDedup && wikiMeta) {
      const entityKey = wikiMeta.entityKey;
      if (!wikiGroups.has(entityKey)) {
        wikiGroups.set(entityKey, {
          best: item,
          bestMeta: wikiMeta,
          bestScore: computeWikiPreferenceScore(item, wikiMeta, preferredWikiLang),
          langs: new Set([wikiMeta.lang]),
          firstSlotIndex: nonWikiOrBestList.length
        });
        nonWikiOrBestList.push({ type: 'wiki-slot', entityKey });
      } else {
        const group = wikiGroups.get(entityKey);
        group.langs.add(wikiMeta.lang);
        const candScore = computeWikiPreferenceScore(item, wikiMeta, preferredWikiLang);
        if (candScore > group.bestScore) {
          group.best = mergeCandidateMetadata(item, group.best);
          group.bestMeta = wikiMeta;
          group.bestScore = candScore;
        } else {
          group.best = mergeCandidateMetadata(group.best, item);
        }
      }
    } else {
      nonWikiOrBestList.push({ type: 'item', item });
    }
  }

  const afterEntityDedup = [];
  for (const entry of nonWikiOrBestList) {
    if (entry.type === 'wiki-slot') {
      const group = wikiGroups.get(entry.entityKey);
      if (group) {
        afterEntityDedup.push({
          ...group.best,
          mergedWikiLangs: [...group.langs],
          wikiEntityKey: entry.entityKey
        });
      }
    } else {
      afterEntityDedup.push(entry.item);
    }
  }

  // Passo 3: Near-duplicate headline dedup (para notícias/syndication) + Domain Cap
  const seenTitleFingerprints = new Set();
  const domainCounts = new Map();
  let totalWikiCount = 0;
  const finalItems = [];

  for (const item of afterEntityDedup) {
    const isWiki = Boolean(extractWikipediaMeta(item, item.domain));
    if (isWiki && totalWikiCount >= maxTotalWiki) {
      continue;
    }

    // Dedup de manchetes idênticas de agregadores / Google News
    if (item.isNewsHeadline || item.domain === 'news.google.com') {
      const fp = normalizeTitleFingerprint(item.title);
      if (fp.length >= 24) {
        if (seenTitleFingerprints.has(fp)) continue;
        seenTitleFingerprints.add(fp);
      }
    }

    const domKey = String(item.domain || '').toLowerCase();
    const effectiveDomainCap = intent === 'code_repo' && domKey === 'github.com' ? 5 : maxPerDomain;
    const currentDomCount = domainCounts.get(domKey) || 0;
    if (domKey && effectiveDomainCap > 0 && currentDomCount >= effectiveDomainCap) {
      continue;
    }

    domainCounts.set(domKey, currentDomCount + 1);
    if (isWiki) totalWikiCount += 1;
    finalItems.push(item);
  }

  return finalItems;
}

module.exports = {
  TRACKING_QUERY_PARAMS,
  canonicalizeUrl,
  normalizeEntitySlug,
  extractWikipediaMeta,
  deduplicateResults
};
