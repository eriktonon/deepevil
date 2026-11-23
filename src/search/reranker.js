'use strict';

const {
  MULTI_POLAR_RESULTS_COUNT,
  LOW_SIGNAL_DOMAINS,
  HIGH_SIGNAL_DOMAINS,
  normalizeSearchScope,
  isPortugueseOrBrazilianBubbleResult,
  isLowSignalResult,
  toGlobalResearchQuery,
  extractSubjectTokens,
  planSearchIntent
} = require('./planner');
const { canonicalizeUrl, extractWikipediaMeta, deduplicateResults } = require('./dedup');

const POLE_ORDER = ['US', 'CN', 'DE', 'JP', 'KR', 'RU', 'BR'];
const POLE_BADGES = {
  US: '[🇺🇸 US]',
  CN: '[🇨🇳 CN]',
  DE: '[🇩🇪 DE]',
  JP: '[🇯🇵 JP]',
  KR: '[🇰🇷 KR]',
  RU: '[🇷🇺 RU]',
  BR: '[🇧🇷 BR]',
  GLOBAL: '[🌍 GLOBAL]'
};

const ENGINE_WEIGHTS = {
  direct: 2.2,
  searxng: 1.75,
  brave: 1.55,
  ddg: 1.3,
  bing: 1.2,
  gnews: 1.15,
  github: 1.25,
  hn: 1.15,
  habr: 1.15,
  yandex: 1.15,
  wikipedia: 0.9,
  openalex: 0.95,
  crossref: 0.9,
  arxiv: 1.0,
  cyberleninka: 0.85,
  unknown: 0.8
};

const TOKEN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'what', 'when', 'where', 'which', 'who', 'why', 'how',
  'are', 'was', 'were', 'has', 'have', 'had', 'been', 'will', 'can', 'could', 'about', 'over', 'under', 'more', 'most',
  'que', 'para', 'com', 'sem', 'sobre', 'entre', 'uma', 'uns', 'umas', 'dos', 'das', 'nos', 'nas', 'pelo', 'pela',
  'como', 'qual', 'quais', 'quem', 'onde', 'quando', 'por', 'porque', 'este', 'esta', 'esse', 'essa', 'isso', 'isto',
  'der', 'die', 'das', 'und', 'für', 'mit', 'von', 'ein', 'eine', 'auf', 'ist', 'sind',
  'что', 'как', 'для', 'или', 'при', 'это', 'все', 'его', 'она', 'они', 'был', 'была'
]);

const HISTORICAL_CONFLICT_NOISE_RE = /\b(vietnam\s+war|guerra\s+do\s+vietn[ãa]|korean\s+war|6\.25\s*전쟁|world\s+war\s+[i12]|segunda\s+guerra\s+mundial|primeira\s+guerra\s+mundial|cold\s+war|guerra\s+fria|american\s+civil\s+war|napoleonic\s+wars|peloponnesian|traidor\s*\(jogo\)|video\s+game|board\s+game)\b/i;
const ENTERTAINMENT_NOISE_RE = /\b(stage\s+play|philip\s+ridley|streaming\s+music\s+player|grindcore|studio\s+album|video\s+game|survival\s+game|discography|record\s+label|television\s+series|traidor\s*\(jogo\)|jogo\s+eletr[ôo]nico|filme\s+de\s+\d{4})\b/i;

/**
 * Tokenizador multilíngue para BM25 e MMR (Latim normalizado, Cirílico, Callsigns e bigramas CJK).
 */
function tokenizeText(rawText) {
  const normalized = String(rawText || '')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const tokens = [];
  // 1. Callsigns / códigos hifenizados preservados inteiros (ex.: uvb-76, cve-2025-1234, swe-bench)
  for (const m of normalized.matchAll(/\b([a-z\u0400-\u04ff]{2,8}-\d{1,6}(?:-\d{1,6})?)\b/g)) {
    tokens.push(m[1]);
  }

  // 2. Palavras latinas / cirílicas / alfanuméricas
  const words = normalized
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  for (const w of words) {
    // Se for segmento CJK (chinês/japonês/coreano), extrai o segmento e bigramas para recall real
    if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(w)) {
      const cjkRuns = w.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/g) || [];
      for (const run of cjkRuns) {
        if (run.length >= 2) {
          tokens.push(run);
          if (run.length > 2) {
            for (let i = 0; i < run.length - 1 && i < 16; i++) {
              tokens.push(run.slice(i, i + 2));
            }
          }
        }
      }
      continue;
    }

    const cleanW = w.replace(/^-+|-+$/g, '');
    if (!cleanW) continue;
    if (cleanW.length < 3 && !/^(ai|ia|os|3d|go|io|ml|db|js|ts|ru|cn|us|de|jp|kr|br|ip|c#)$/.test(cleanW)) {
      continue;
    }
    if (TOKEN_STOPWORDS.has(cleanW)) continue;
    tokens.push(cleanW);
  }

  return tokens;
}

function getDomainFromItem(item) {
  if (item?.domain) return String(item.domain).replace(/^www\./i, '').toLowerCase();
  try {
    return new URL(item.url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function extractPublishedYear(item) {
  if (Number.isInteger(item?.publishedYear)) return item.publishedYear;
  const text = `${item?.title || ''} ${item?.pubDate || ''} ${item?.description || ''}`;
  const m = text.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function isAcademicDomain(host) {
  return (
    host === 'arxiv.org' ||
    host === 'export.arxiv.org' ||
    host === 'openalex.org' ||
    host === 'doi.org' ||
    host === 'cyberleninka.ru' ||
    host.endsWith('.ieee.org') ||
    host === 'ieee.org' ||
    host.endsWith('.acm.org') ||
    host === 'acm.org' ||
    host === 'sciencedirect.com' ||
    host === 'springer.com' ||
    host === 'link.springer.com' ||
    host === 'ncbi.nlm.nih.gov' ||
    host === 'pmc.ncbi.nlm.nih.gov'
  );
}

function isNewsOrConflictTrackerDomain(host) {
  return (
    host.includes('liveuamap.com') ||
    host.includes('acleddata.com') ||
    host.includes('understandingwar.org') ||
    host.includes('reuters.com') ||
    host.includes('apnews.com') ||
    host.includes('bbc.com') ||
    host.includes('bbc.co.uk') ||
    host.includes('aljazeera.com') ||
    host.includes('theguardian.com') ||
    host.includes('crisisgroup.org') ||
    host.includes('news.google.com')
  );
}

function isTechDocsDomain(host) {
  return (
    host === 'github.com' ||
    host === 'gitlab.com' ||
    host === 'backbox.org' ||
    host.endsWith('.backbox.org') ||
    host === 'kali.org' ||
    host.endsWith('.kali.org') ||
    host === 'cgsecurity.org' ||
    host === 'sleuthkit.org' ||
    host === 'kernel.org' ||
    host === 'lwn.net' ||
    host === 'stackoverflow.com' ||
    host === 'askubuntu.com' ||
    host === 'unix.stackexchange.com' ||
    host === 'wiki.archlinux.org' ||
    host === 'docs.rs' ||
    host === 'developer.mozilla.org' ||
    host === 'modelscope.cn' ||
    host === 'opencsg.com' ||
    host === 'wisemodel.cn' ||
    host === 'gitee.com' ||
    host === 'ai.gitee.com' ||
    host.startsWith('docs.')
  );
}

/**
 * Calcula coerência e autoridade global de um item (mantido para compatibilidade retroativa com testes e normalizeTopResults).
 */
function scoreResultCoherence(item, query = '') {
  if (!item || !item.url) return -100;
  const host = getDomainFromItem(item);
  if (!host) return -100;

  let score = 0;

  if (LOW_SIGNAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    score -= 60;
  }

  if (HIGH_SIGNAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    score += 25;
  }

  if (query && isPortugueseOrBrazilianBubbleResult(item, query)) {
    score -= 120;
  }

  const rawText = `${item.title || ''} ${item.description || ''}`;
  const isNativeCjkOrCyrillic = /[\u4e00-\u9fff\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af]/.test(rawText);
  if (item.countryPole || isNativeCjkOrCyrillic) {
    score += 20;
  }

  if (query) {
    const queryTokens = extractSubjectTokens(`${query} ${toGlobalResearchQuery(query)}`);
    const hay = `${item.title || ''} ${item.description || ''} ${item.url || ''}`.toLowerCase();

    if (!/\b(banda|m[úu]sica|filme|[áa]lbum|pe[çc]a|jogo|game|music|movie|play)\b/i.test(query)) {
      if (ENTERTAINMENT_NOISE_RE.test(hay)) {
        score -= 55;
      }
    }

    if (queryTokens.length > 0 && !item.countryPole && !isNativeCjkOrCyrillic) {
      const matchedCount = queryTokens.filter((tok) => hay.includes(tok)).length;
      if (matchedCount === 0) {
        score -= 45;
      } else if (queryTokens.length >= 3 && matchedCount === 1 && score > 0) {
        score -= 15;
      }
    }
  }

  return score;
}

/**
 * Normaliza, deduplica por URL canônica, pontua coerência global e retorna até `count` resultados.
 */
function normalizeTopResults(rawItems = [], count = 6, query = '') {
  const seenKeys = new Set();
  const deduped = [];

  for (let idx = 0; idx < rawItems.length; idx++) {
    const item = rawItems[idx];
    if (!item || typeof item.url !== 'string') continue;
    const canon = canonicalizeUrl(item.url);
    if (!canon) continue;
    if (seenKeys.has(canon.canonicalKey)) continue;
    seenKeys.add(canon.canonicalKey);

    const normalizedItem = {
      ...item,
      url: canon.url,
      title: String(item.title || canon.domain).replace(/\s+/g, ' ').trim(),
      description: String(item.description || item.content || '').replace(/\s+/g, ' ').trim()
    };
    if (item.countryPole) normalizedItem.countryPole = item.countryPole;

    deduped.push({
      item: normalizedItem,
      originalIndex: idx,
      score: query ? scoreResultCoherence(normalizedItem, query) : 0
    });
  }

  const highCoherencePool = deduped.filter((entry) => entry.score > -40);
  const effectivePool = highCoherencePool.length >= Math.min(2, count) ? highCoherencePool : deduped;

  effectivePool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  return effectivePool.slice(0, count).map((entry) => entry.item);
}

/**
 * Calcula Okapi BM25 (k1=1.5, b=0.75) com pesos por campo (title=2.6, url=1.3, description=1.0).
 */
function computeBm25Scores(candidates, queryTerms) {
  const N = candidates.length;
  if (N === 0 || queryTerms.length === 0) {
    return candidates.map(() => ({ bm25: 0, matchedTerms: 0, coverage: 0, docTokens: new Set() }));
  }

  const uniqueQueryTerms = [...new Set(queryTerms)];
  const docData = candidates.map((item) => {
    const titleToks = tokenizeText(item.title || '');
    const urlToks = tokenizeText(String(item.url || '').replace(/^https?:\/\/(?:www\.)?/i, ' '));
    const descToks = tokenizeText(item.description || item.content || '');

    const tf = new Map();
    const addWeighted = (toks, weight) => {
      for (const t of toks) {
        tf.set(t, (tf.get(t) || 0) + weight);
      }
    };
    addWeighted(titleToks, 2.6);
    addWeighted(urlToks, 1.3);
    addWeighted(descToks, 1.0);

    const docLen = titleToks.length * 2.6 + urlToks.length * 1.3 + descToks.length || 1;
    const docTokens = new Set([...titleToks, ...urlToks, ...descToks]);
    return { tf, docLen, docTokens };
  });

  const avgdl = docData.reduce((acc, d) => acc + d.docLen, 0) / N || 1;
  const df = new Map();
  for (const qt of uniqueQueryTerms) {
    let count = 0;
    for (const d of docData) {
      if (d.tf.has(qt)) {
        count += 1;
      } else {
        // Prefixo/substring para termos >= 5 chars (stemming leve PT/EN/DE/RU)
        const stem = qt.length >= 5 ? qt.slice(0, Math.max(4, qt.length - 2)) : '';
        if (stem) {
          for (const dt of d.docTokens) {
            if (dt.startsWith(stem) || dt.includes(qt)) {
              count += 1;
              break;
            }
          }
        }
      }
    }
    df.set(qt, count);
  }

  const k1 = 1.5;
  const b = 0.75;

  return docData.map((d) => {
    let rawBm25 = 0;
    let matchedTerms = 0;

    for (const qt of uniqueQueryTerms) {
      let termFreq = d.tf.get(qt) || 0;
      if (termFreq === 0 && qt.length >= 5) {
        const stem = qt.slice(0, Math.max(4, qt.length - 2));
        for (const [dt, f] of d.tf.entries()) {
          if (dt.startsWith(stem) || dt.includes(qt)) {
            termFreq += f * 0.7;
          }
        }
      }
      if (termFreq <= 0) continue;
      matchedTerms += 1;
      const docFreq = df.get(qt) || 0;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      const denom = termFreq + k1 * (1 - b + b * (d.docLen / avgdl));
      rawBm25 += idf * ((termFreq * (k1 + 1)) / (denom || 1));
    }

    const coverage = uniqueQueryTerms.length > 0 ? matchedTerms / uniqueQueryTerms.length : 0;
    return { bm25: rawBm25, matchedTerms, coverage, docTokens: d.docTokens };
  });
}

function computeRrfScore(item, plan) {
  const k = 60;
  let rrf = 0;
  const ranks = item.engineRanks && Object.keys(item.engineRanks).length > 0
    ? item.engineRanks
    : { [item.engine || 'unknown']: Number.isFinite(item.engineRank) ? item.engineRank : (item._origIdx || 0) + 1 };

  for (const [eng, rank] of Object.entries(ranks)) {
    const baseWeight = Object.prototype.hasOwnProperty.call(ENGINE_WEIGHTS, eng)
      ? ENGINE_WEIGHTS[eng]
      : ENGINE_WEIGHTS.unknown;

    let multiplier = 1.0;
    if (plan?.intent === 'breaking_news') {
      if (eng === 'searxng' || eng === 'gnews' || eng === 'ddg' || eng === 'brave') multiplier = 1.35;
      else if (eng === 'wikipedia') multiplier = 0.4;
      else if (eng === 'openalex' || eng === 'crossref' || eng === 'cyberleninka' || eng === 'arxiv') multiplier = 0.25;
    } else if (plan?.intent === 'howto_tech') {
      if (eng === 'searxng' || eng === 'ddg' || eng === 'bing' || eng === 'brave' || eng === 'github') multiplier = 1.3;
      else if (eng === 'openalex' || eng === 'crossref' || eng === 'cyberleninka') multiplier = 0.3;
    } else if (plan?.intent === 'code_repo') {
      if (eng === 'github' || eng === 'direct') multiplier = 1.5;
    }

    const safeRank = Math.max(1, Number(rank) || 1);
    rrf += (baseWeight * multiplier) / (k + safeRank);
  }
  return rrf;
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!denom) return 0;
  // Mapeia [-1, 1] -> [0, 1]
  return Math.max(0, Math.min(1, (dot / denom + 1) / 2));
}

function computeDocSimilarity(a, b) {
  // Mesma entidade Wikipedia -> quase duplicado
  if (a.wikiEntityKey && b.wikiEntityKey && a.wikiEntityKey === b.wikiEntityKey) {
    return 0.95;
  }
  const domA = a.domain || '';
  const domB = b.domain || '';
  const sameDomainBoost = domA && domA === domB ? 0.35 : 0;

  const setA = a.docTokens;
  const setB = b.docTokens;
  if (!setA || !setB || setA.size === 0 || setB.size === 0) {
    return sameDomainBoost;
  }

  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  return Math.min(1, jaccard * 0.75 + sameDomainBoost);
}

/**
 * Estágio 1 + Hard Relevance Threshold + MMR (síncrono, ultrarrápido e determinístico).
 */
function rerankCandidates(rawCandidates = [], query = '', options = {}) {
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) return [];

  const plan = options.plan || planSearchIntent(query, {
    focusMode: options.focusMode || 'web',
    searchScope: options.searchScope || 'global'
  });
  const totalCount = Number.isFinite(Number(options.count)) ? Number(options.count) : MULTI_POLAR_RESULTS_COUNT;
  const strictThreshold = Boolean(options.strictThreshold);
  const lambda = Number.isFinite(Number(options.mmrLambda)) ? Number(options.mmrLambda) : 0.72;
  const useMultiPolarMmr = Boolean(options.useMultiPolarMmr);
  const minThreshold = Number.isFinite(Number(options.minRelevanceThreshold))
    ? Number(options.minRelevanceThreshold)
    : (strictThreshold ? 0.22 : 0.08);

  // Deduplica primeiro
  const deduped = options.skipDedup
    ? rawCandidates
    : deduplicateResults(rawCandidates, {
        searchLang: options.searchLang || 'pt-BR',
        intent: plan.intent,
        maxPerDomain: options.maxPerDomain ?? 2
      });

  if (deduped.length === 0) return [];

  // Constrói lista de termos de consulta (original + global + subQueries + termos de polos opcionais)
  const extraTermsText = Array.isArray(options.extraQueryTerms)
    ? options.extraQueryTerms.join(' ')
    : String(options.extraQueryTerms || '');
  const fullQueryText = `${query} ${plan.globalQuery} ${(plan.subQueries || []).join(' ')} ${extraTermsText}`;
  const queryTerms = tokenizeText(fullQueryText);
  const coreSubjectTokens = plan.subjectTokens || extractSubjectTokens(query);

  const bm25Metrics = computeBm25Scores(deduped, queryTerms);
  const maxBm25 = Math.max(0.001, ...bm25Metrics.map((m) => m.bm25));
  const rawRrfScores = deduped.map((item) => computeRrfScore(item, plan));
  const maxRrf = Math.max(0.001, ...rawRrfScores);

  const isEntertainmentQuery = /\b(banda|m[úu]sica|filme|[áa]lbum|pe[çc]a|jogo|game|music|movie|play|traidor)\b/i.test(query);
  const mentionsHistoricalWar = /\b(vietn[ãa]|vietnam|coreia\s+1950|6\.25|segunda\s+guerra|primeira\s+guerra|world\s+war|cold\s+war|guerra\s+fria)\b/i.test(query);
  const currentYear = new Date().getFullYear();

  const scored = [];
  for (let i = 0; i < deduped.length; i++) {
    const item = deduped[i];
    const host = getDomainFromItem(item);
    if (!host || isLowSignalResult(item)) continue;

    const textAll = `${item.title || ''} ${item.description || ''} ${item.url || ''}`;
    const lowerAll = textAll.toLowerCase();

    // Descarte imediato de entretenimento/jogos quando a query não é de entretenimento
    if (!isEntertainmentQuery && ENTERTAINMENT_NOISE_RE.test(lowerAll)) {
      continue;
    }

    // Descarte imediato de guerras históricas antigas quando a query pede conflitos de HOJE / semana
    if ((plan.intent === 'breaking_news' || plan.freshness === 'day' || plan.freshness === 'week') && !mentionsHistoricalWar) {
      if (HISTORICAL_CONFLICT_NOISE_RE.test(lowerAll)) {
        continue;
      }
    }

    // Se a query contém callsigns específicos (ex.: UVB-76) e estamos em strictThreshold, exige o callsign ou menção direta
    if (strictThreshold && plan.callsigns.length > 0 && !item.isDirectCandidate) {
      const normAll = lowerAll.replace(/[\u2010-\u2015\u2212]/g, '-');
      const hasCallsignOrRadioContext =
        plan.callsigns.some((cs) => {
          const [p, n] = cs.split('-');
          return new RegExp(`(?:^|[^\\p{L}\\p{N}])${p}[-\\s]?${n}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(normAll);
        }) || /\b(buzzer|увб-?76|numbers\s+station|shortwave|mdzhb|жжжалка)\b/i.test(normAll);
      if (!hasCallsignOrRadioContext && bm25Metrics[i].matchedTerms < 2) {
        continue;
      }
    }

    const normBm25 = bm25Metrics[i].bm25 / maxBm25;
    const normRrf = rawRrfScores[i] / maxRrf;
    const isWiki = Boolean(extractWikipediaMeta(item, host));
    const isAcad = isAcademicDomain(host);
    const isHighSignal = HIGH_SIGNAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    const pubYear = extractPublishedYear(item);

    let adjustment = 0;

    if (item.isDirectCandidate) adjustment += 0.45;
    if (isHighSignal) adjustment += 0.14;
    if (item.engine === 'searxng' || (Array.isArray(item.engines) && item.engines.includes('searxng'))) {
      adjustment += 0.16;
    }

    // Bônus/penalidades por intent & freshness
    if (plan.intent === 'breaking_news' || plan.freshness === 'day' || plan.freshness === 'week') {
      if (isNewsOrConflictTrackerDomain(host) || item.isNewsHeadline) adjustment += 0.22;
      if (pubYear && pubYear >= currentYear - 1) adjustment += 0.16;
      if (isWiki) adjustment -= 0.36;
      if (isAcad && (!pubYear || pubYear < currentYear - 1)) adjustment -= 0.55;
      else if (pubYear && pubYear < currentYear - 3) adjustment -= 0.35;
    } else if (plan.intent === 'howto_tech') {
      if (isTechDocsDomain(host)) adjustment += 0.22;
      if (isAcad) adjustment -= 0.42;
      if (isWiki && bm25Metrics[i].matchedTerms < 2) adjustment -= 0.22;
    } else if (plan.intent === 'code_repo') {
      if (host === 'github.com' || host === 'gitlab.com' || host === 'docs.rs') adjustment += 0.24;
      if (isAcad && !/\b(paper|algorithm)\b/i.test(query)) adjustment -= 0.2;
    } else if (plan.intent === 'deep_research') {
      if (isAcad || isHighSignal) adjustment += 0.12;
      if (plan.targetYear && pubYear && pubYear < plan.targetYear - 4) adjustment -= 0.18;
    }

    // Penalidade forte quando não há nenhum match lexical e o candidato não tem sinal semântico/autoridade forte
    const hasNonLatinScript = /[\u4e00-\u9fff\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af]/.test(textAll);
    let lexicalScore = 0.58 * normBm25 + 0.32 * normRrf + adjustment;

    if (strictThreshold && bm25Metrics[i].matchedTerms === 0 && !item.isDirectCandidate) {
      // Sem nenhum overlap lexical com query/subQueries/termos dos polos
      if (!hasNonLatinScript) {
        lexicalScore -= 0.48;
      } else {
        lexicalScore -= 0.25;
      }
    }

    // Penalidade extra para match de apenas 1 termo genérico quando a query possui 3+ termos substantivos em modo estrito
    if (
      strictThreshold &&
      coreSubjectTokens.length >= 3 &&
      bm25Metrics[i].matchedTerms === 1 &&
      !hasNonLatinScript &&
      !item.isDirectCandidate &&
      !(item.engines && item.engines.includes('searxng'))
    ) {
      lexicalScore -= 0.18;
    }

    // Mescla semântica se já estiver disponível em item._semanticScore (preenchido pelo Estágio 2 async)
    const clampedLexical = Math.max(0, Math.min(1.5, lexicalScore));
    const hasSemantic = typeof item._semanticScore === 'number' && Number.isFinite(item._semanticScore);
    const finalScore = hasSemantic
      ? 0.55 * Math.min(1, clampedLexical) + 0.45 * item._semanticScore
      : clampedLexical;

    // Hard Relevance Threshold: descarta lixo irrelevante em vez de preencher cota com ruído!
    if (finalScore < minThreshold && !item.isDirectCandidate) {
      continue;
    }

    scored.push({
      item,
      domain: host,
      pole: item.countryPole || 'GLOBAL',
      finalScore,
      lexicalScore: clampedLexical,
      semanticScore: hasSemantic ? item._semanticScore : null,
      matchedTerms: bm25Metrics[i].matchedTerms,
      docTokens: bm25Metrics[i].docTokens,
      wikiEntityKey: item.wikiEntityKey || null,
      origIdx: Number.isFinite(item._origIdx) ? item._origIdx : i
    });
  }

  if (scored.length === 0) return [];

  // Ordenação inicial por score descendente
  scored.sort((a, b) => (b.finalScore - a.finalScore) || (a.origIdx - b.origIdx));

  // Seleção MMR (Maximal Marginal Relevance) + cota soft de diversidade de polos
  const selected = [];
  const remaining = [...scored];
  const coveredPoles = new Set();
  const poleOrderIndex = new Map(POLE_ORDER.map((p, idx) => [p, idx]));

  // Em modo multi-polo (selectMultiPolarTopResults), garante que o 1º slot relevante de cada polo
  // presente no conjunto filtrado receba diversidade suave (cota soft) sem jamais aceitar off-topic.
  const directPicked = [];
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (remaining[i].item.isDirectCandidate) {
      directPicked.unshift(remaining.splice(i, 1)[0]);
    }
  }
  for (const dp of directPicked) {
    if (selected.length >= totalCount) break;
    selected.push(dp);
    coveredPoles.add(dp.pole);
  }

  if (useMultiPolarMmr) {
    // Passada 1 (Cota Soft de Polos): para cada polo na ordem canônica, pega o melhor candidato
    // QUE JÁ PASSOU no Hard Relevance Threshold (nunca reintroduz lixo!).
    for (const pole of POLE_ORDER) {
      if (selected.length >= totalCount) break;
      if (coveredPoles.has(pole)) continue;
      let bestIdx = -1;
      let bestVal = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i];
        if (cand.pole !== pole) continue;
        const maxSim = selected.length > 0
          ? Math.max(...selected.map((s) => computeDocSimilarity(cand, s)))
          : 0;
        const mmrVal = lambda * cand.finalScore - (1 - lambda) * maxSim;
        if (mmrVal > bestVal) {
          bestVal = mmrVal;
          bestIdx = i;
        }
      }
      if (bestIdx !== -1) {
        const chosen = remaining.splice(bestIdx, 1)[0];
        selected.push(chosen);
        coveredPoles.add(pole);
      }
    }
  }

  // Passada 2 (MMR puro até totalCount)
  while (selected.length < totalCount && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const maxSim = selected.length > 0
        ? Math.max(...selected.map((s) => computeDocSimilarity(cand, s)))
        : 0;
      const unseenPoleBonus = !coveredPoles.has(cand.pole) && cand.pole !== 'GLOBAL' ? 0.14 : 0;
      const poleTieBreak = poleOrderIndex.has(cand.pole)
        ? (POLE_ORDER.length - poleOrderIndex.get(cand.pole)) * 0.001
        : 0;
      const mmrScore = lambda * cand.finalScore - (1 - lambda) * maxSim + unseenPoleBonus + poleTieBreak;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    selected.push(chosen);
    coveredPoles.add(chosen.pole);
  }

  return selected.map((entry) => {
    const out = { ...entry.item };
    delete out._origIdx;
    delete out._semanticScore;
    out.rerankScore = Number(entry.finalScore.toFixed(4));
    return out;
  });
}

/**
 * Estágio 2 opcional: consulta `embedTextsBatch` de `../qdrant` (bge-m3 1024d) com timeout curto (1500ms)
 * e funde `0.55 * lexical + 0.45 * cosine`, com fallback transparente caso indisponível.
 */
async function rerankCandidatesAsync(rawCandidates = [], query = '', options = {}) {
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) return [];

  const plan = options.plan || planSearchIntent(query, {
    focusMode: options.focusMode || 'web',
    searchScope: options.searchScope || 'global'
  });

  const deduped = deduplicateResults(rawCandidates, {
    searchLang: options.searchLang || 'pt-BR',
    intent: plan.intent,
    maxPerDomain: options.maxPerDomain ?? 2
  });

  if (deduped.length === 0) return [];

  const enableSemantic = options.enableSemantic !== false && !options.isMock;
  let enrichedCandidates = deduped;

  if (enableSemantic && deduped.length >= 2 && query) {
    let qdrantMod = null;
    try {
      qdrantMod = require('../qdrant');
    } catch (_) {
      qdrantMod = null;
    }

    if (qdrantMod && typeof qdrantMod.embedTextsBatch === 'function') {
      const semanticTimeoutMs = Number.isFinite(Number(options.semanticTimeoutMs))
        ? Number(options.semanticTimeoutMs)
        : 1500;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), semanticTimeoutMs);
      const extSignal = options.signal || null;
      const onExtAbort = () => controller.abort();
      if (extSignal) {
        if (extSignal.aborted) controller.abort();
        else extSignal.addEventListener('abort', onExtAbort, { once: true });
      }

      try {
        // Limita o batch aos top 18 candidatos por Estágio 1 para manter latência ultra-baixa
        const topForSemantic = deduped.slice(0, 18);
        const texts = [
          String(plan.globalQuery || query).slice(0, 512),
          ...topForSemantic.map((c) => `${c.title || ''} ${c.description || ''}`.replace(/\s+/g, ' ').trim().slice(0, 512))
        ];

        const batchRes = await qdrantMod.embedTextsBatch(texts, {
          env: options.env || process.env,
          timeoutMs: semanticTimeoutMs,
          signal: controller.signal
        });

        const vectors = Array.isArray(batchRes?.vectors)
          ? batchRes.vectors
          : Array.isArray(batchRes?.embeddings)
          ? batchRes.embeddings
          : Array.isArray(batchRes)
          ? batchRes
          : null;

        if (vectors && vectors.length === texts.length && Array.isArray(vectors[0]) && vectors[0].length >= 128) {
          const queryVec = vectors[0];
          const semanticByKey = new Map();
          for (let i = 0; i < topForSemantic.length; i++) {
            const cVec = vectors[i + 1];
            if (Array.isArray(cVec) && cVec.length === queryVec.length) {
              semanticByKey.set(topForSemantic[i].canonicalKey || topForSemantic[i].url, cosineSimilarity(queryVec, cVec));
            }
          }
          enrichedCandidates = deduped.map((c) => {
            const sem = semanticByKey.get(c.canonicalKey || c.url);
            return typeof sem === 'number' ? { ...c, _semanticScore: sem } : c;
          });
        }
      } catch (_) {
        // Graceful fallback transparente para Estágio 1
      } finally {
        clearTimeout(timer);
        if (extSignal) {
          extSignal.removeEventListener('abort', onExtAbort);
        }
      }
    }
  }

  return rerankCandidates(enrichedCandidates, query, {
    ...options,
    plan,
    skipDedup: true
  });
}

function tagItemWithPole(item, pole) {
  const badge = POLE_BADGES[pole] || POLE_BADGES.GLOBAL;
  const cleanTitle = String(item.title || '').trim();
  const taggedTitle = cleanTitle.startsWith('[') ? cleanTitle : `${badge} ${cleanTitle}`;
  return {
    ...item,
    title: taggedTitle,
    countryPole: item.countryPole || pole
  };
}

function collectFilteredPoolCandidates({
  directCandidates = [],
  usPool = [],
  cnPool = [],
  dePool = [],
  jpPool = [],
  krPool = [],
  ruPool = [],
  brPool = [],
  globalPool = []
} = {}, query = '', searchScope = 'global') {
  const effectiveScope = normalizeSearchScope(searchScope);
  const combined = [];

  if (effectiveScope === 'brazil') {
    for (let i = 0; i < directCandidates.length; i++) {
      const d = directCandidates[i];
      if (!d || typeof d.url !== 'string' || isLowSignalResult(d)) continue;
      combined.push({ ...tagItemWithPole(d, 'BR'), isDirectCandidate: true, engine: d.engine || 'direct', engineRank: i + 1 });
    }
    for (let i = 0; i < brPool.length; i++) {
      const b = brPool[i];
      if (!b || typeof b.url !== 'string' || isLowSignalResult(b)) continue;
      combined.push({ ...tagItemWithPole(b, 'BR'), engineRank: b.engineRank || i + 1 });
    }
    return combined;
  }

  const filterCheckQuery = effectiveScope === 'external' ? '' : query;

  for (let i = 0; i < directCandidates.length; i++) {
    const d = directCandidates[i];
    if (!d || typeof d.url !== 'string') continue;
    if (effectiveScope === 'external' && d.countryPole === 'BR') continue;
    if (d.countryPole === 'BR' ? isLowSignalResult(d) : isPortugueseOrBrazilianBubbleResult(d, filterCheckQuery, true)) {
      continue;
    }
    combined.push({ ...d, isDirectCandidate: true, engine: d.engine || 'direct', engineRank: i + 1 });
  }

  const pushPool = (pool, pole, allowPt = false) => {
    if (!Array.isArray(pool)) return;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (!item || typeof item.url !== 'string') continue;
      if (allowPt) {
        if (isLowSignalResult(item)) continue;
      } else {
        if (isLowSignalResult(item)) continue;
        if (isPortugueseOrBrazilianBubbleResult(item, filterCheckQuery, true)) continue;
      }
      combined.push({
        ...tagItemWithPole(item, pole),
        engineRank: item.engineRank || i + 1
      });
    }
  };

  pushPool(usPool, 'US', false);
  pushPool(cnPool, 'CN', false);
  pushPool(dePool, 'DE', false);
  pushPool(jpPool, 'JP', false);
  pushPool(krPool, 'KR', false);
  pushPool(ruPool, 'RU', false);
  if (effectiveScope !== 'external') {
    pushPool(brPool, 'BR', true);
  }
  pushPool(globalPool, 'GLOBAL', false);

  return combined;
}

/**
 * Entrypoint síncrono retrocompatível substituindo o round-robin cego por:
 * Deduplicação Canônica/Cross-Lingual + BM25 + RRF + Hard Relevance Threshold + MMR Multi-Polo.
 */
function selectMultiPolarTopResults(pools = {}, totalCount = MULTI_POLAR_RESULTS_COUNT, query = '', searchScope = 'global', options = {}) {
  const candidates = collectFilteredPoolCandidates(pools, query, searchScope);
  if (candidates.length === 0) return [];

  return rerankCandidates(candidates, query, {
    ...options,
    count: totalCount,
    searchScope: normalizeSearchScope(searchScope),
    useMultiPolarMmr: true,
    maxPerDomain: options.maxPerDomain ?? 3,
    minRelevanceThreshold: options.strictThreshold ? (options.minRelevanceThreshold ?? 0.22) : 0.01
  });
}

/**
 * Entrypoint assíncrono completo (Estágio 1 BM25+RRF + Estágio 2 opcional bge-m3 1024d + Hard Threshold + MMR).
 */
async function selectMultiPolarTopResultsAsync(pools = {}, totalCount = MULTI_POLAR_RESULTS_COUNT, query = '', searchScope = 'global', options = {}) {
  const candidates = collectFilteredPoolCandidates(pools, query, searchScope);
  if (candidates.length === 0) return [];

  return rerankCandidatesAsync(candidates, query, {
    ...options,
    count: totalCount,
    searchScope: normalizeSearchScope(searchScope),
    useMultiPolarMmr: true,
    strictThreshold: options.strictThreshold !== false,
    maxPerDomain: options.maxPerDomain ?? 2
  });
}

module.exports = {
  POLE_ORDER,
  POLE_BADGES,
  tokenizeText,
  scoreResultCoherence,
  normalizeTopResults,
  computeBm25Scores,
  computeRrfScore,
  cosineSimilarity,
  rerankCandidates,
  rerankCandidatesAsync,
  selectMultiPolarTopResults,
  selectMultiPolarTopResultsAsync
};
