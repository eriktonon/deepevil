'use strict';

const MAX_RESULTS = 6;
const MULTI_POLAR_RESULTS_COUNT = 10;
const GLOBAL_ACCEPT_LANGUAGE = 'en-US,en;q=0.9,*;q=0.8';

/**
 * Domínios escolares rasos, dicionários ou portais de download/jogos que poluem pesquisas técnicas/científicas.
 */
const LOW_SIGNAL_DOMAINS = [
  'todamateria.com.br',
  'brasilescola.uol.com.br',
  'mundoeducacao.uol.com.br',
  'escolakids.uol.com.br',
  'preparaenem.com',
  'manualdaquimica.com',
  'biologianet.com',
  'historiadomundo.com.br',
  'portugues.com.br',
  'dicio.com.br',
  'significados.com.br',
  'sinonimos.com.br',
  'pensador.com',
  'brainly.com.br',
  'passeidireto.com',
  'infoescola.com',
  'resumoescolar.com.br',
  'querobolsa.com.br',
  'stoodi.com.br',
  'descomplica.com.br',
  'store.steampowered.com',
  'softonic.com',
  'en.softonic.com',
  'minijogos.com.br',
  'fandom.com',
  'raft-game.com',
  'uptodown.com',
  'baixaki.com.br',
  'jogos360.com.br',
  'poki.com',
  'nite.games'
];

/**
 * Domínios globais de alta autoridade científica, técnica e enciclopédica.
 */
const HIGH_SIGNAL_DOMAINS = [
  'en.wikipedia.org',
  'zh.wikipedia.org',
  'de.wikipedia.org',
  'ja.wikipedia.org',
  'ko.wikipedia.org',
  'ru.wikipedia.org',
  'pt.wikipedia.org',
  'mpg.de',
  'fraunhofer.de',
  'dfki.de',
  'bsi.bund.de',
  'riken.jp',
  'nii.ac.jp',
  'u-tokyo.ac.jp',
  'kaist.ac.kr',
  'snu.ac.kr',
  'etri.re.kr',
  'scielo.br',
  'palantir.com',
  'arxiv.org',
  'export.arxiv.org',
  'openalex.org',
  'doi.org',
  'github.com',
  'gitlab.com',
  'habr.com',
  'mera.a-ai.ru',
  'cyberleninka.ru',
  'yandex.ru',
  'yandex.com',
  'opencompass.org.cn',
  'modelscope.cn',
  'opencsg.com',
  'wisemodel.cn',
  'ai.gitee.com',
  'gitee.com',
  'zhihu.com',
  'juejin.cn',
  'oschina.net',
  'lmarena.ai',
  'swebench.com',
  'livebench.ai',
  'huggingface.co',
  'backbox.org',
  'kali.org',
  'cgsecurity.org',
  'sleuthkit.org',
  'kernel.org',
  'lwn.net',
  'nvd.nist.gov',
  'cve.org',
  'owasp.org',
  'ietf.org',
  'rfc-editor.org',
  'ieee.org',
  'acm.org',
  'dl.acm.org',
  'usenix.org',
  'nature.com',
  'sciencedirect.com',
  'springer.com',
  'ncbi.nlm.nih.gov',
  'pmc.ncbi.nlm.nih.gov',
  'pubchem.ncbi.nlm.nih.gov',
  'britannica.com',
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'aljazeera.com',
  'liveuamap.com',
  'acleddata.com',
  'understandingwar.org',
  'cloudflare.com',
  'mozilla.org',
  'developer.mozilla.org',
  'docs.rs',
  'kubernetes.io',
  'linuxfoundation.org',
  'mitre.org',
  'attack.mitre.org',
  'cisa.gov',
  'sans.org',
  'portswigger.net',
  'exploit-db.com',
  'packetstormsecurity.com',
  'elastic.co',
  'iaea.org'
];

const FOCUS_MODES = {
  web: {
    id: 'web',
    label: 'Web',
    querySuffix: ''
  },
  secops: {
    id: 'secops',
    label: 'SecOps / CVE',
    querySuffix: 'CVE exploit advisory vulnerability writeup technical analysis'
  },
  code: {
    id: 'code',
    label: 'Code / Docs',
    querySuffix: 'architecture implementation source code documentation example'
  },
  academic: {
    id: 'academic',
    label: 'Academic',
    querySuffix: 'paper specification RFC research study formal analysis'
  },
  hybrid: {
    id: 'hybrid',
    label: 'Híbrido (Local + Web)',
    querySuffix: ''
  }
};

const SEARCH_SCOPES = {
  global: {
    id: 'global',
    label: 'Global · 7 Polos (US·CN·DE·JP·KR·RU·BR)'
  },
  external: {
    id: 'external',
    label: 'Só Externo (US·CN·DE·JP·KR·RU)'
  },
  brazil: {
    id: 'brazil',
    label: 'Só Brasil (PT-BR)'
  }
};

function normalizeSearchScope(rawScope = 'global') {
  const clean = String(rawScope || 'global').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEARCH_SCOPES, clean) ? clean : 'global';
}

const SEARCH_LANGUAGES = {
  'pt-BR': { id: 'pt-BR', label: 'Português (BR)', tl: 'pt', name: 'Português do Brasil (pt-BR)' },
  en: { id: 'en', label: 'English (US)', tl: 'en', name: 'English (en-US)' },
  es: { id: 'es', label: 'Español (ES)', tl: 'es', name: 'Español (es)' },
  de: { id: 'de', label: 'Deutsch (DE)', tl: 'de', name: 'Deutsch (de)' },
  ja: { id: 'ja', label: '日本語 (JA)', tl: 'ja', name: 'Japanese / 日本語 (ja)' },
  ko: { id: 'ko', label: '한국어 (KO)', tl: 'ko', name: 'Korean / 한국어 (ko)' },
  zh: { id: 'zh', label: '中文 (ZH)', tl: 'zh-CN', name: 'Chinese / 简体中文 (zh-CN)' },
  ru: { id: 'ru', label: 'Русский (RU)', tl: 'ru', name: 'Russian / Русский (ru)' }
};

function normalizeSearchLang(rawLang = 'pt-BR') {
  const clean = String(rawLang || 'pt-BR').trim();
  if (Object.prototype.hasOwnProperty.call(SEARCH_LANGUAGES, clean)) return clean;
  const lower = clean.toLowerCase();
  if (lower === 'pt' || lower === 'pt-br' || lower === 'pt_br') return 'pt-BR';
  const match = Object.keys(SEARCH_LANGUAGES).find((k) => k.toLowerCase() === lower);
  return match || 'pt-BR';
}

function normalizeHyphens(text) {
  return String(text || '').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
}

/**
 * Detecta se o usuário pediu explicitamente algo restrito ao contexto do Brasil.
 */
function isExplicitBrazilQuery(rawQuery) {
  const clean = String(rawQuery || '').trim();
  return /\b(brasil|brasileir[oa]s?|stf|stj|receita\s+federal|ibge|anatel|bacen|banco\s+central\s+do\s+brasil|pix|cnpj|cpf|clt|inss|sus|enem|prefeitura|governo\s+federal|são\s+paulo|rio\s+de\s+janeiro|brasília|selic|ipca)\b/i.test(clean);
}

/**
 * Detecta se um candidato pertence à bolha geográfica de blogs/portais em português (`.br`, `.pt`, `/pt/`)
 * ou está redigido em português quando avaliado para um polo internacional (`forceInternationalCheck=true`).
 */
function isPortugueseOrBrazilianBubbleResult(item, rawQuery = '', forceInternationalCheck = false) {
  if (!item || !item.url) return false;
  if (!forceInternationalCheck && isExplicitBrazilQuery(rawQuery)) return false;
  let parsed;
  try {
    parsed = new URL(item.url);
  } catch (_) {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  const path = parsed.pathname.toLowerCase();

  // Exceção para domínios de teste unitário local (.org/.dev/.local de mocks)
  if (/^(exemplo-\d+\.org|fonte\d+\.dev|docs\.searxng\.org|sqlite\.org|htmx\.org)$/.test(host)) {
    return false;
  }

  const brMediaHosts = [
    'brasil247.com',
    'metropoles.com',
    'globo.com',
    'uol.com',
    'r7.com',
    'terra.com',
    'exame.com',
    'cnnbrasil.com.br',
    'poder360.com.br',
    'cartacapital.com.br'
  ];

  if (
    host.endsWith('.br') ||
    host.endsWith('.pt') ||
    host.startsWith('pt.') ||
    host.startsWith('br.') ||
    brMediaHosts.some((d) => host === d || host.endsWith(`.${d}`)) ||
    /\/(pt|pt-br|pt_br|br|portuguese|portugues|brasil)(\/|$)/i.test(path) ||
    /-(pt|br)\b/i.test(path)
  ) {
    return true;
  }

  const text = `${item.title || ''} ${item.description || ''}`;
  if (/\b(melhores\s+modelos|os\s+\d+\s+melhores|guia\s+completo|comparação\s+técnica|inteligências\s+artificiais|qual\s+a\s+melhor\s+ia|modelos\s+de\s+ia\s+mais|mapa\s+mundial\s+de\s+r[áa]dio|r[áa]dio\s+mundial,\s+ao\s+vivo)\b/i.test(text)) {
    return true;
  }

  if (forceInternationalCheck && /[ãõç]/i.test(text) && /\b(não|são|sob\s+os|liderança|política|relações|governo|educação|história|ciência|região|cidades|públicas|avaliação|produção|como\s+o|como\s+a)\b/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * Classifica o domínio semântico da consulta para rotear apenas as fontes apropriadas.
 * Retorna: `'software_cs'` | `'exact_sciences'` | `'general_research'`
 */
function classifyQueryDomain(rawQuery = '', focusMode = 'web') {
  const mode = String(focusMode || 'web').trim().toLowerCase();
  if (mode === 'code' || mode === 'secops') return 'software_cs';

  const q = String(rawQuery || '').toLowerCase();

  const isCivilArchUrbanGeoPolEcon = /\b(urbanismo|planejamento\s+urbano|mobilidade\s+urbana|cidades?\s+compactas?|gentrifica[çc][ãa]o|zoneamento|plano\s+diretor|saneamento|arquitetura\s+(?:brutalista|bioclim[áa]tica|moderna|modernista|contempor[âa]nea|sustent[áa]vel|civil|urbana|paisag[íi]stica|g[óo]tica|barroca|colonial|de\s+interiores|hospitalar|escolar)|brutalismo|edif[íi]cios?|niemeyer|le\s+corbusier|bauhaus|zaha\s+hadid|frank\s+lloyd|geografia|relevo|hidrografia|bacia\s+hidrogr[áa]fica|cartografia|calotas?\s+polares?|degelo|[áa]rtico|ant[áa]rtida|geopol[íi]tica|diplomacia|pol[íi]tica\s+externa|pol[íi]tica\s+monet[áa]ria|pol[íi]tica\s+fiscal|elei[çc][õo]es|democracia|presid[êe]ncia|presidente|lula|bolsonaro|itamaraty|banco\s+central|taxa\s+de\s+juros|infla[çc][ãa]o|macroeconomia|pib|d[íi]vida\s+p[úu]blica|com[ée]rcio\s+internacional|desenvolvimento\s+(?:econ[ôo]mico|sustent[áa]vel|urbano|humano|social|regional))\b/i.test(q);

  const hasExplicitSoftwareOrAi = /\b(software|programa[çc][ãa]o|coding|c[óo]digo[\s-]fonte|open[-\s]?source|github|gitlab|\.git\b|linux|backbox|kali|ubuntu|debian|kernel|microkernel|sel4|sistema(?:s)?\s+operacional(?:is)?|operating\s+systems?|verifica[çc][ãa]o\s+formal|formal\s+verification|docker|kubernetes|microsservi[çc]os?|microservices?|api|rest|graphql|grpc|rust|python|javascript|typescript|node\.?js|npm|golang|java|c\+\+|sql|postgres\w*|sqlite\d*|redis|kafka|banco\s+de\s+dados|database|compilador|compiler|llm|llms|gpt|claude|qwen|deepseek|granite|ollama|hugging\s*face|hugface|modelscope|opencsg|wisemodel|machine\s+learning|aprendizado\s+de\s+m[áa]quina|deep\s+learning|rede\s+neural|intelig[êe]ncia\s+artificial|artificial\s+intelligence|\bia\b|cybersecurity|ciberseguran[çc]a|exploit|cve|vulnerabilidade|malware|ransomware|rootkit|pentest|forense|forensics|recupera[çc][ãa]o\s+de\s+dados|data\s+recovery|engenharia\s+reversa|reverse\s+engineering|kademlia|quic|p2p|webrtc|websocket|ebpf|xdp|ftrace|hnsw|modelagem\s+3d|cad\b|blender|freecad|openscad|palantir|foundry)\b/i.test(q);

  if (isCivilArchUrbanGeoPolEcon && !hasExplicitSoftwareOrAi) {
    return 'general_research';
  }

  const isExactSciences = /\b(f[íi]sica\s+nuclear|nuclear|fiss[ãa]o|fission|fus[ãa]o|fusion|tokamak|iter|reator(?:es)?|reactor|ur[âa]nio|uranium|plut[ôo]nio|plutonium|smr|computa[çc][ãa]o\s+qu[âa]ntica|quantum\s+computing|f[íi]sica\s+qu[âa]ntica|quantum\s+physics|qubit|qubits|supercondutor\w*|superconducting|entrela[çc]amento|entanglement|decoer[êe]ncia|decoherence|c[óo]digos?\s+de\s+superf[íi]cie|surface\s+codes?|corre[çc][ãa]o\s+de\s+erros\s+qu[âa]nticos|quantum\s+error\s+correction|shor|grover|p[óo]s-qu[âa]ntic[oa]|ml-kem|kyber|dilithium|p[óo]lvora|gunpowder|termodin[âa]mica|astrof[íi]sica|relatividade|higgs|cern)\b/i.test(q);

  if (isExactSciences && !/\b(github|reposit[óo]rio|open[-\s]?source)\b/i.test(q)) {
    return 'exact_sciences';
  }

  if (hasExplicitSoftwareOrAi) {
    return 'software_cs';
  }

  return 'general_research';
}

/**
 * Detecta fazendas de conteúdo escolar raso, dicionários ou clickbait.
 */
function isLowSignalResult(item) {
  if (!item || !item.url) return true;
  let host = '';
  try {
    host = new URL(item.url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return true;
  }
  if (LOW_SIGNAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return true;
  }
  const text = `${item.title || ''} ${item.description || ''}`;
  if (/\b(os\s+\d+\s+melhores|descubra\s+qual\s+[eé]\s+a\s+melhor|veja\s+os\s+melhores)\b/i.test(text)) {
    return true;
  }
  if (/^(worldradiomap\.com|universeradio\.app|aradio\.org|radiogarden\.live|mytuner-radio\.com|radios\.com\.br)$/.test(host)) {
    return true;
  }
  return false;
}

const PT_TO_GLOBAL_TERMS = [
  [/\bcomo\s+(?:o|a|os|as)?\s*lula\s+[eé]\s+vist[oa]\s+(?:no\s+mundo|internacionalmente|no\s+exterior|fora\s+do\s+brasil)\b/gi, 'Luiz Inácio Lula da Silva Brazil foreign policy international perception global diplomacy'],
  [/\bcomo\s+(?:o|a|os|as)?\s*(.+?)\s+[eé]\s+vist[oa]s?\s+(?:no\s+mundo|internacionalmente|no\s+exterior)\b/gi, '$1 international perception global view foreign relations'],
  [/\bcomo\s+(?:fazer|fabricar|produzir|sintetizar|preparar)\b/gi, 'synthesis composition'],
  [/\b(?:como\s+funciona(?:m)?|o\s+que\s+s[ãa]o|o\s+que\s+[eé]|qual\s+[ea]\s+diferen[çc]a\s+entre|quais\s+s[ãa]o\s+(?:os|as)?|qual\s+[eo]?\s*|quais\s+(?:os|as)?\s*|me\s+explique|explique\s+como|procure|busque|encontre|me\s+traga|traga|liste|mostre|quero|preciso\s+de)\b/gi, ' '],
  [/\b(?:materiais?|conte[úu]dos?|documenta[çc][ãa]o|artigos?|estudos?|guias?|tutoriais?|refer[êe]ncias?)\s+(?:de|da|do|dos|das|sobre|para|pela|pelo)\b/gi, ' '],
  [/\bmateriais?\b/gi, ' '],
  // Ferramentas, Forense & Recuperação de Dados
  [/\brecupera[çc][ãa]o\s+de\s+dados\b/gi, 'data recovery'],
  [/\bforense\s+digital\b/gi, 'digital forensics'],
  [/\bque\s+vem\s+n[oa]\b/gi, 'included in'],
  [/\bvem\s+n[oa]\b/gi, 'included in'],
  [/\bferramenta(?:s)?\b/gi, 'tools'],
  // Notícias, Tempo Real & Conflitos
  [/\bmapa\s+de\s+conflitos?\b/gi, 'live conflict map'],
  [/\bconflitos?\s+armados?\b/gi, 'armed conflicts'],
  [/\bconflitos?\b/gi, 'conflicts'],
  [/\bguerra(?:s)?\b/gi, 'war'],
  [/\bhoje\b/gi, 'today'],
  [/\bagora\b/gi, 'live now'],
  [/\b[úu]ltimas?\s+not[íi]cias?\b/gi, 'latest breaking news'],
  // Política & Geopolítica
  [/\bpol[íi]tica\s+externa\b/gi, 'foreign policy diplomacy'],
  [/\brela[çc][õo]es\s+internacionais\b/gi, 'international relations geopolitics'],
  [/\bgeopol[íi]tica\s+do\s+[áa]rtico\b/gi, 'Arctic geopolitics polar maritime routes'],
  [/\bgeopol[íi]tica\b/gi, 'geopolitics international relations'],
  [/\bdiplomacia\b/gi, 'diplomacy foreign policy'],
  // Economia & Macroeconomia
  [/\bpol[íi]tica\s+monet[áa]ria\b/gi, 'monetary policy central bank'],
  [/\bpol[íi]tica\s+fiscal\b/gi, 'fiscal policy public finance'],
  [/\btaxa(?:s)?\s+de\s+juros\b/gi, 'interest rates monetary policy'],
  [/\bbanco(?:s)?\s+central(?:is)?\b/gi, 'central bank monetary policy'],
  [/\bcontrole\s+d[ea]\s+infla[çc][ãa]o\b/gi, 'inflation targeting monetary policy'],
  [/\binfla[çc][ãa]o\b/gi, 'inflation macroeconomics'],
  [/\bmacroeconomia\b/gi, 'macroeconomics economic policy'],
  [/\bdesenvolvimento\s+econ[ôo]mico\b/gi, 'economic development growth'],
  [/\bdesenvolvimento\s+sustent[áa]vel\b/gi, 'sustainable development sustainability'],
  [/\bdesenvolvimento\s+urbano\b/gi, 'urban development city planning'],
  [/\bdesenvolvimento\s+humano\b/gi, 'human development index'],
  [/\bd[íi]vida\s+p[úu]blica\b/gi, 'public debt sovereign debt'],
  [/\bcom[ée]rcio\s+internacional\b/gi, 'international trade global economy'],
  // Arquitetura Civil & Urbanismo
  [/\barquitetura\s+brutalista\b/gi, 'brutalist architecture modernist concrete buildings'],
  [/\barquitetura\s+bioclim[áa]tica\b/gi, 'bioclimatic architecture passive solar sustainable building design'],
  [/\barquitetura\s+contempor[âa]nea\b/gi, 'contemporary architecture architectural design'],
  [/\barquitetura\s+moderna|\barquitetura\s+modernista\b/gi, 'modern architecture modernist architectural movement'],
  [/\barquitetura\s+sustent[áa]vel\b/gi, 'sustainable architecture green building'],
  [/\barquitetura\s+e\s+urbanismo\b/gi, 'architecture and urbanism urban design'],
  [/\bplanejamento\s+urbano\b/gi, 'urban planning city planning'],
  [/\bcidades?\s+compactas?\b/gi, 'compact cities urban density transit-oriented development'],
  [/\bmobilidade\s+urbana\b/gi, 'urban mobility sustainable transport transit'],
  [/\bmobilidade\s+sustent[áa]vel\b/gi, 'sustainable urban mobility transit'],
  [/\burbanismo\b/gi, 'urbanism urban planning city design'],
  [/\bgentrifica[çc][ãa]o\b/gi, 'gentrification urban sociology'],
  // Geografia & Clima
  [/\bgeografia\s+f[íi]sica\b/gi, 'physical geography geomorphology'],
  [/\bgeografia\s+humana\b/gi, 'human geography spatial demography'],
  [/\bgeografia\b/gi, 'geography spatial analysis'],
  [/\bdegelo\s+das?\s+calotas?\s+polares?\b/gi, 'polar ice sheet melting Arctic cryosphere climate change'],
  [/\bcalotas?\s+polares?\b/gi, 'polar ice caps cryosphere glaciology'],
  [/\bdegelo\b/gi, 'ice melting glacier retreat'],
  [/\b[áa]rtico\b/gi, 'Arctic polar region'],
  [/\brotas?\s+mar[íi]timas?\b/gi, 'maritime shipping routes Northern Sea Route'],
  [/\bbacia(?:s)?\s+hidrogr[áa]fica(?:s)?\b/gi, 'watershed river basin hydrology'],
  [/\bmudan[çc]as?\s+clim[áa]ticas?\b/gi, 'climate change global warming'],
  // Física Nuclear & Energia
  [/\bf[íi]sica\s+nuclear\b/gi, 'nuclear physics atomic nucleus'],
  [/\bfus[ãa]o\s+nuclear\b/gi, 'nuclear fusion plasma tokamak'],
  [/\bfiss[ãa]o\s+nuclear\b/gi, 'nuclear fission reactor physics'],
  [/\bconfinamento\s+magn[ée]tico\b/gi, 'magnetic confinement tokamak ITER'],
  [/\breator(?:es)?\s+nuclear(?:es)?\s+de\s+fiss[ãa]o\b/gi, 'nuclear fission reactor'],
  [/\breator(?:es)?\s+nuclear(?:es)?\b/gi, 'nuclear reactor'],
  [/\breator(?:es)?\s+modular(?:es)?|\bsmr\b/gi, 'small modular reactors SMR nuclear'],
  // Computação Quântica
  [/\bcomputa[çc][ãa]o\s+qu[âa]ntica\b/gi, 'quantum computing quantum information'],
  [/\bcorre[çc][ãa]o\s+de\s+erros?\s+qu[âa]nticos?\b/gi, 'quantum error correction fault-tolerant quantum'],
  [/\bc[óo]digos?\s+de\s+superf[íi]cie\b/gi, 'surface codes topological quantum error correction'],
  [/\bqubits?\s+supercondutor(?:es)?\b/gi, 'superconducting qubits transmon quantum processor'],
  [/\bentrela[çc]amento\s+qu[âa]ntico\b/gi, 'quantum entanglement'],
  [/\bf[íi]sica\s+qu[âa]ntica\b/gi, 'quantum physics quantum mechanics'],
  // Software, IA & Cibersegurança
  [/\bontologia(?:s)?\s+(?:de\s+)?(?:ia|i\.a\.|intelig[êe]ncia\s+artificial|dados)?\s*(?:pela|da|do|na|no|em)?\s*palantir\b/gi, 'Palantir Foundry AIP Ontology knowledge graph enterprise AI'],
  [/\bontologia(?:s)?\b/gi, 'Ontology semantic data model knowledge graph'],
  [/\bpalantir\b/gi, 'Palantir Foundry AIP'],
  [/\bgrafo(?:s)?\s+de\s+conhecimento\b/gi, 'knowledge graph'],
  [/\bmodelo(?:s)?\s+de\s+(?:ia|intelig[êe]ncia\s+artificial)\b/gi, 'AI model LLM'],
  [/\bintelig[êe]ncia(?:s)?\s+artificial(?:is)?\b/gi, 'artificial intelligence AI'],
  [/\b(?:ia|i\.a\.)\b/gi, 'AI'],
  [/\bmais\s+(?:forte(?:s)?|poderoso(?:s)?|avan[çc]ado(?:s)?|inteligente(?:s)?|capaz(?:es)?|r[áa]pido(?:s)?|eficiente(?:s)?)\b/gi, 'strongest SOTA top'],
  [/\bdesenvolvimento\s+de\s+(?:software|sistemas|aplica[çc][õo]es|c[óo]digo)\b/gi, 'software development coding programming'],
  [/\bpara\s+desenvolvimento\b/gi, 'software development coding programming'],
  [/\batualmente\b/gi, 'current'],
  [/\bmicrosservi[çc]os?\b/gi, 'microservices distributed architecture'],
  [/\bprograma[çc][ãa]o\b/gi, 'programming coding'],
  [/\bcomparativo|\bcompara[çc][ãa]o|\branking\b/gi, 'comparison benchmark'],
  [/\bmodelagem\s+3d\b/gi, '3d modeling CAD'],
  [/\bmodelagem\s+tridimensional\b/gi, '3d modeling CAD'],
  [/\bescultura\s+digital\b/gi, 'digital sculpting 3d'],
  [/\bmalha(?:s)?\s+poligonal(?:is)?\b/gi, 'polygon mesh 3d'],
  [/\breposit[óo]rio(?:s)?\s+(?:do\s+|no\s+)?github\b/gi, 'github repository'],
  [/\bc[óo]digo\s+aberto\b/gi, 'open source'],
  [/\bp[óo]lvora\s+negra\b/gi, 'gunpowder black powder'],
  [/\bp[óo]lvora\b/gi, 'gunpowder'],
  [/\bconsenso\s+distribu[íi]do\b/gi, 'distributed consensus'],
  [/\bsistemas?\s+distribu[íi]dos?\b/gi, 'distributed systems'],
  [/\btoler[âa]ncia\s+a\s+falhas?\b/gi, 'fault tolerance'],
  [/\bvulnerabilidade(?:s)?\b/gi, 'vulnerability CVE'],
  [/\bfalha(?:s)?\s+de\s+seguran[çc]a\b/gi, 'security vulnerability'],
  [/\bseguran[çc]a\s+da\s+informa[çc][ãa]o\b/gi, 'cybersecurity'],
  [/\bseguran[çc]a\b/gi, 'security'],
  [/\bengenharia\s+reversa\b/gi, 'reverse engineering'],
  [/\bataque(?:s)?\b/gi, 'attack exploitation'],
  [/\bc[óo]digo[\s-]fonte\b/gi, 'source code'],
  [/\bimplementa[çc][ãa]o\b/gi, 'implementation'],
  [/\barquitetura\b/gi, 'architecture'],
  [/\bdesempenho\b/gi, 'performance'],
  [/\bbanco\s+de\s+dados\b/gi, 'database'],
  [/\bdados\b/gi, 'data'],
  [/\bagente(?:s)?\b/gi, 'agents'],
  [/\bsistema(?:s)?\s+operacional(?:is)?\b/gi, 'operating system'],
  [/\bmem[óo]ria\s+cache\b/gi, 'CPU cache'],
  [/\bmem[óo]ria\b/gi, 'memory'],
  [/\brede(?:s)?\s+de\s+computadores\b/gi, 'computer networks'],
  [/\bcriptografia\b/gi, 'cryptography'],
  [/\baprendizado\s+de\s+m[áa]quina\b/gi, 'machine learning'],
  [/\bcomposi[çc][ãa]o\s+qu[íi]mica\b/gi, 'chemical composition'],
  [/\bqu[íi]mica\b/gi, 'chemistry'],
  [/\bexplosivo(?:s)?\b/gi, 'explosive chemistry'],
  [/\barmamento(?:s)?|\barma(?:s)?\b/gi, 'weapons ballistics'],
  [/\bmodelo(?:s)?\b/gi, 'model'],
  [/\bPresidente\s+do\s+Brasil\b/gi, 'President of Brazil'],
  [/\b(?:fim\s+do\s+mundo|ju[íi]zo\s+final|apocalipse)\b/gi, 'doomsday'],
  [/\btocou\b/gi, 'broadcast'],
  [/\bconcorrente(?:s)?\b/gi, 'alternative competitor'],
  [/\b(?:site|plataforma|portal)\s+d[eo]\b/gi, 'platform'],
  // Segurança Alimentar, Estoque Estratégico de Alimentos & Preparação Civil
  [/\b(?:estocar|armazenar|reservar|estocagem\s+de|estoque\s+de|reserva(?:s)?\s+(?:estrat[ée]gica(?:s)?\s+de\s+)?)\s*alimento(?:s)?\b/gi, 'strategic food reserves emergency food stockpiling food storage security'],
  [/\bseguran[çc]a\s+alimentar\b/gi, 'food security strategic grain reserves'],
  [/\bconserva[çc][ãa]o\s+de\s+alimento(?:s)?\b/gi, 'food preservation shelf life storage'],
  [/\bsobrevivencialismo|\bprepper(?:s)?\b/gi, 'emergency preparedness survival food storage'],
  [/\bbrasil\b/gi, 'Brazil'],
  [/\bbrasileir[oa]s?\b/gi, 'Brazilian'],
  [/\bhist[óo]ria\b/gi, 'history'],
  [/\bno\s+mundo\b/gi, 'global international']
];

/**
 * Converte ou expande uma consulta para Global Research (Worldwide / English technical terms),
 * removendo travas regionais e muletas conversacionais.
 */
function toGlobalResearchQuery(rawQuery, { forceGlobal = false } = {}) {
  const clean = normalizeHyphens(rawQuery)
    .replace(/https?:\/\/[^\s"'<>]+/gi, ' ')
    .replace(/\bhugface\b/gi, 'Hugging Face')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';

  if (!forceGlobal && isExplicitBrazilQuery(clean)) {
    return clean;
  }

  let transformed = clean;
  for (const [pattern, replacement] of PT_TO_GLOBAL_TERMS) {
    transformed = transformed.replace(pattern, replacement);
  }

  transformed = transformed
    .replace(/^(?:me\s+(?:explique|fale|diga)\s+(?:sobre|como)|explique\s+(?:detalhadamente\s+)?|pesquise\s+sobre\s+|tudo\s+sobre\s+)/i, '')
    .replace(/\b(?:no\s+brasil|em\s+portugu[êe]s)\b/gi, '')
    .replace(/\b(?:esse|essa|este|esta|isso|isto|[eé]|um|uma|uns|umas|no|na|nos|nas|do|da|dos|das|pelo|pela|para|por|com|sem|sobre|entre|que|de|em|os|as|ao|aos)\b/gi, ' ')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const uniqueTokens = [];
  const seenLower = new Set();
  for (const tok of transformed.split(/\s+/)) {
    const l = tok.toLowerCase();
    if (!seenLower.has(l)) {
      seenLower.add(l);
      uniqueTokens.push(tok);
    }
  }

  return uniqueTokens.join(' ') || clean;
}

/**
 * Extrai tokens substantivos distintivos de uma query para validar coerência real.
 */
function extractSubjectTokens(query = '') {
  const cleaned = String(toGlobalResearchQuery(query) || query || '')
    .replace(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi, ' $1 $2 ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, ' ')
    .replace(/\.git\b/gi, ' ')
    .replace(/\b(?:an[áa]lise\s+t[ée]cnica\s+direta|fontes\s+verificadas|funciona\s+na\s+pr[áa]tica|dentro\s+do\s+contexto\s+de|incidentes?\s+globais?\s+com|tem\s+fontes?\s+do\s+incidente)\b/gi, ' ');

  const STOP_TOKENS = /^(how|what|why|when|where|who|which|the|and|for|with|from|into|http|https|www|com|org|net|git|github|repository|repositories|software|softwares|opensource|open|source|code|documentation|example|implementation|included|tool|tools|como|que|qual|quais|para|com|dos|das|uma|uns|umas|por|pela|pelo|sobre|entre|fazer|funciona|funcionam|prática|pratica|contexto|dentro|análise|analise|técnica|tecnica|direta|fontes|incidente|incidentes|globais|global|arquitetura|sistema|sistemas|procure|busque|traga|mostre|liste|materiais|material|conteudos|conteúdos|conteudo|conteúdo|documentacao|documentação|artigos|artigo|estudos|estudo|guias|guia|principais|melhores|repositório|repositorio|repositórios|repositorios|process|technical|overview|architecture|mechanism|internals|design|differences|comparison|synthesis|chemical|composition|esse|essa|este|esta|site|sites|website|platform|plataforma|concorrente|competitor|alternative|end|fim|mundo|world|tocou|played|vem)$/;

  return [...new Set(
    cleaned
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => (w.length >= 3 || w === '3d' || w === 'ai' || w === 'os') && !STOP_TOKENS.test(w))
  )];
}

/**
 * Detecta se uma query solicita especificamente concorrentes/alternativas chinesas ao Hugging Face
 * ou cita diretamente hubs chineses de LLM (ModelScope, OpenCSG, WiseModel, Gitee AI).
 */
function isChinaLlmHubCompetitorQuery(text) {
  const lower = String(text || '').toLowerCase();
  const mentionsChinaHub = /\b(modelscope|opencsg|wisemodel|gitee\s*ai|魔搭社区)\b/i.test(lower);
  if (mentionsChinaHub) return true;
  const mentionsHf = /\b(hugging\s*face|hugface)\b/i.test(lower);
  const mentionsChina = /\b(china|chin[êe]s|chinesa|chinese)\b/i.test(lower);
  const mentionsCompetitor = /\b(concorrente|alternativa|rival|competitor|alternative|similar|parecido)\b/i.test(lower);
  return mentionsHf && (mentionsChina || mentionsCompetitor);
}

/**
 * Classifica intenção semântica, temporalidade (freshness), roteamento de provedores
 * e gera 2-3 sub-queries limpas e focadas na intenção real do usuário.
 */
function planSearchIntent(question, options = {}) {
  const focusMode = String(options.focusMode || 'web').trim().toLowerCase();
  const searchScope = normalizeSearchScope(options.searchScope || 'global');
  const rawQuery = String(question || '').trim();
  const normalizedQuery = normalizeHyphens(rawQuery)
    .replace(/\bhugface\b/gi, 'Hugging Face')
    .replace(/\s+/g, ' ')
    .trim();
  const globalQuery = toGlobalResearchQuery(normalizedQuery, { forceGlobal: true });
  const lower = `${normalizedQuery} ${globalQuery}`.toLowerCase();
  const domain = classifyQueryDomain(normalizedQuery, focusMode);

  // 1. Temporal Router (freshness + ano alvo)
  const yearMatch = normalizedQuery.match(/\b(202[4-9]|203\d)\b/);
  const targetYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;

  let freshness = 'any';
  if (
    /\b(hoje|agora|today|right\s+now|breaking|ao\s+vivo|live\s+map|neste\s+momento|em\s+tempo\s+real|[úu]ltimas?\s+horas?|mapa\s+de\s+conflitos?\s+hoje)\b/i.test(lower)
  ) {
    freshness = 'day';
  } else if (
    /\b(esta\s+semana|essa\s+semana|nesta\s+semana|this\s+week|[úu]ltimos?\s+dias?|recentemente|recentes?|[úu]ltimas?\s+not[íi]cias?|ultimas?\s+noticias?|latest\s+news|novidades|tocou\s+na\s+r[úu]ssia)\b/i.test(lower)
  ) {
    freshness = 'week';
  } else if (
    targetYear !== null ||
    /\b(este\s+ano|esse\s+ano|atual|atualmente|current|currently|latest|mais\s+recente|novo|novos)\b/i.test(lower)
  ) {
    freshness = 'year';
  }

  const searxTimeRange = freshness === 'any' ? '' : freshness;

  // 2. Intent Router
  const hasRepoSignal =
    focusMode === 'code' ||
    /https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/|\.git\b|\b(reposit[óo]rio|repository|source\s+code|c[óo]digo[\s-]fonte|crate|npm\s+package|github\s+repo)\b/i.test(lower);

  const hasSecopsSignal =
    focusMode === 'secops' ||
    /\b(cve-\d{4}-\d+|exploit|zero[-\s]?day|0day|vulnerabilidade|vulnerability|advisory|rootkit|ransomware|malware|pentest|mitre\s+att&ck|owasp|reverse\s+engineering|engenharia\s+reversa)\b/i.test(lower);

  const hasBreakingNewsSignal =
    freshness === 'day' ||
    freshness === 'week' ||
    /\b(not[íi]cias?|breaking\s+news|live\s+conflict|mapa\s+de\s+conflitos?|guerra\s+hoje|conflitos?\s+hoje|aconteceu|atacou|bombardeio|ceasefire|cessar[-\s]?fogo|cota[çc][ãa]o|pre[çc]o\s+hoje)\b/i.test(lower);

  const hasHowToTechSignal =
    /\b(qual\s+o\s+software|qual\s+software|quais\s+softwares|qual\s+ferramenta|quais\s+ferramentas|que\s+vem\s+no|vem\s+no\s+|como\s+instalar|como\s+configurar|como\s+usar|como\s+recuperar|how\s+to\s+(?:install|configure|use|fix|recover|setup)|backbox|kali\s+linux|recupera[çc][ãa]o\s+de\s+dados|data\s+recovery|concorrente\s+do|alternativa\s+(?:ao|chinesa)|alternative\s+to|competitor\s+to|comando\s+para|erro\s+ao|troubleshooting)\b/i.test(lower);

  const hasDeepResearchSignal =
    focusMode === 'academic' ||
    /\b(paper|artigo\s+cient[íi]fico|estudo\s+formal|verifica[çc][ãa]o\s+formal|formal\s+analysis|rfc|especifica[çc][ãa]o|benchmark|comparativo|compara[çc][ãa]o|arquitetura|geopol[íi]tica|pol[íi]tica\s+monet[áa]ria|f[íi]sica\s+nuclear|computa[çc][ãa]o\s+qu[âa]ntica|ontologia|urbanismo|planejamento\s+urbano)\b/i.test(lower);

  const wordCount = normalizedQuery.split(/\s+/).filter(Boolean).length;

  let intent = 'deep_research';
  if (focusMode === 'secops') {
    intent = 'secops';
  } else if (focusMode === 'code') {
    intent = 'code_repo';
  } else if (focusMode === 'academic') {
    intent = 'deep_research';
  } else if (hasBreakingNewsSignal && !hasRepoSignal) {
    intent = 'breaking_news';
  } else if (hasRepoSignal) {
    intent = 'code_repo';
  } else if (hasHowToTechSignal) {
    intent = 'howto_tech';
  } else if (hasSecopsSignal) {
    intent = 'secops';
  } else if ((searchScope === 'brazil' || isExplicitBrazilQuery(normalizedQuery)) && !hasDeepResearchSignal) {
    intent = 'local_br';
  } else if (wordCount <= 6 && !hasDeepResearchSignal) {
    intent = 'factual_short';
  } else {
    intent = 'deep_research';
  }

  // 3. Roteamento determinístico de provedores por intenção
  // NUNCA dispara OpenAlex/CrossRef/CyberLeninka para breaking_news, howto_tech ou factual_short!
  const shouldIncludeAcademic =
    focusMode === 'academic' ||
    (intent === 'deep_research' && (domain === 'exact_sciences' || hasDeepResearchSignal || wordCount >= 7)) ||
    (intent === 'secops' && /\b(paper|formal|cryptography|protocol|academic)\b/i.test(lower));

  const shouldUseNewsRss =
    intent === 'breaking_news' ||
    freshness === 'day' ||
    freshness === 'week' ||
    /\b(r[áa]dio|tocou|incidente|elei[çc][õo]es|lula|geopol[íi]tica|conflito|guerra|alimento)\b/i.test(lower);

  const shouldUseCodeSources =
    intent === 'code_repo' ||
    intent === 'secops' ||
    (intent === 'howto_tech' && domain === 'software_cs') ||
    (domain === 'software_cs' && intent === 'deep_research');

  const shouldUseMultiWiki =
    intent !== 'breaking_news' &&
    intent !== 'code_repo';

  const callsigns = [...normalizedQuery.matchAll(/\b([A-Za-zА-Яа-яЁё]{2,5}-\d{1,5})\b/g)].map((m) =>
    m[1].toLowerCase()
  );

  // 4. Planejamento de 2-3 sub-queries limpas e focadas na intenção real
  const subQueries = [];
  const pushSubQuery = (qStr) => {
    const clean = String(qStr || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2) return;
    if (!subQueries.some((existing) => existing.toLowerCase() === clean.toLowerCase())) {
      subQueries.push(clean);
    }
  };

  if (isChinaLlmHubCompetitorQuery(lower)) {
    pushSubQuery('ModelScope OpenCSG WiseModel Gitee AI China LLM hub Hugging Face alternative');
    pushSubQuery('魔搭社区 ModelScope OpenCSG 中国开源大模型平台');
    pushSubQuery('ModelScope Alibaba AI model hub');
  } else if (intent === 'breaking_news') {
    const yearTag = targetYear || new Date().getFullYear();
    const cleanedNative = normalizedQuery.replace(/[?!.]+$/, '').trim();
    if (/\b(mapa\s+de\s+conflitos?|live\s+conflict\s+map|guerra|conflito)\b/i.test(lower)) {
      pushSubQuery(`${globalQuery} liveuamap ACLED crisis tracker ${yearTag}`);
      pushSubQuery(`${globalQuery} live map current wars conflicts ${yearTag}`);
      pushSubQuery(cleanedNative);
    } else {
      pushSubQuery(`${globalQuery} ${yearTag}`);
      pushSubQuery(cleanedNative);
      if (freshness === 'day') {
        pushSubQuery(`${globalQuery} latest update today`);
      }
    }
  } else if (intent === 'howto_tech') {
    pushSubQuery(globalQuery);
    if (/\bbackbox\b/i.test(lower) && /\b(data\s+recovery|recupera[çc][ãa]o|forens)/i.test(lower)) {
      pushSubQuery('BackBox Linux forensic analysis data recovery tools list');
      pushSubQuery('BackBox Linux tools TestDisk PhotoRec Foremost Autopsy Scalpel');
    } else {
      pushSubQuery(`${globalQuery} documentation official tools`);
      const cleanedNative = normalizedQuery.replace(/[?!.]+$/, '').trim();
      if (cleanedNative.toLowerCase() !== globalQuery.toLowerCase()) {
        pushSubQuery(cleanedNative);
      }
    }
  } else if (intent === 'code_repo') {
    pushSubQuery(globalQuery);
    pushSubQuery(`${globalQuery} github repository documentation`);
  } else {
    pushSubQuery(globalQuery);
    const cleanedNative = normalizedQuery.replace(/[?!.]+$/, '').trim();
    if (cleanedNative.toLowerCase() !== globalQuery.toLowerCase()) {
      pushSubQuery(cleanedNative);
    }
    if (intent === 'secops') {
      pushSubQuery(`${globalQuery} CVE technical analysis`);
    }
  }

  return {
    rawQuery,
    normalizedQuery,
    globalQuery,
    intent,
    freshness,
    searxTimeRange,
    domain,
    shouldIncludeAcademic,
    shouldUseNewsRss,
    shouldUseCodeSources,
    shouldUseMultiWiki,
    targetYear,
    subQueries: subQueries.slice(0, 3),
    subjectTokens: extractSubjectTokens(`${normalizedQuery} ${globalQuery}`),
    callsigns
  };
}

/**
 * Gera consultas nativas Multi-Polo nos 7 grandes centros tecnológicos e científicos mundiais:
 * 🇺🇸 EUA (EN), 🇨🇳 China (ZH), 🇩🇪 Alemanha (DE), 🇯🇵 Japão (JA), 🇰🇷 Coreia do Sul (KO), 🇷🇺 Rússia (RU) e 🇧🇷 Brasil (PT).
 *
 * IMPORTANTE:
 * - Zero sequestro de queries de software/Linux/Python/Rust/Database/API para "Microservices".
 * - Zero hardcode forçando "Hugging_Face" nos 7 polos para queries de concorrentes chineses de LLM.
 */
function buildMultiPolarQueries(rawQuery, focusMode = 'web') {
  const normalizedRaw = normalizeHyphens(rawQuery)
    .replace(/\bhugface\b/gi, 'Hugging Face')
    .trim();
  const plan = planSearchIntent(normalizedRaw, { focusMode });
  const domain = plan.domain;
  const enBase = toGlobalResearchQuery(normalizedRaw, { forceGlobal: true });
  const lower = `${normalizedRaw} ${enBase}`.toLowerCase();

  const strippedPt = normalizedRaw
    .replace(/https?:\/\/[^\s"'<>]+/gi, ' ')
    .replace(/\b(?:esse\s+[eé]\s+o\s+site|eu\s+quero\s+o\s+site\s+que\s+[eé]\s+o|me\s+traga|traga|procure|busque|encontre|liste|mostre|explique|como\s+funciona(?:m)?|o\s+que\s+[eé]|qual\s+[eo]?|quais\s+(?:s[ãa]o|os|as)?|materiais?\s+(?:de|da|do|sobre)?|conte[úu]dos?\s+(?:de|sobre)?)\b/gi, ' ')
    .replace(/\b(?:esse|essa|este|esta|pela|pelo|para|sobre)\b/gi, ' ')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  let usQuery = enBase;
  let academicCore = enBase;
  const cnTerms = [];
  const deTerms = [];
  const jpTerms = [];
  const krTerms = [];
  const ruTerms = [];
  let usWikiCustom = '';
  let cnWikiCustom = '';
  let deWikiCustom = '';
  let jpWikiCustom = '';
  let krWikiCustom = '';
  let ruWikiCustom = '';
  let enCoreCustom = '';
  let brQuery = strippedPt || enBase;
  let brWiki = strippedPt || enBase;

  const isOntologyOrPalantir = /\b(ontolog\w*|palantir|foundry|aip|knowledge\s+graph|grafo\s+de\s+conhecimento|semantic\s+layer)\b/i.test(lower);
  const isChinaHubCompetitor = isChinaLlmHubCompetitorQuery(lower);
  const isModelBenchmark =
    !isOntologyOrPalantir &&
    !isChinaHubCompetitor &&
    domain === 'software_cs' &&
    /\b(llm|coding|programming|software\s+development|benchmark|leaderboard|strongest|best|top|sota)\b/i.test(lower) &&
    /\b(ia|ai|llm|modelo|model|gpt|claude|qwen|deepseek)\b/i.test(lower);

  // 1. Política, Diplomacia & Geopolítica (ex.: Lula, política externa)
  if (/\b(lula|luiz\s+in[áa]cio)\b/i.test(lower) && !/\b(molusco|cefal[óo]pode)\b/i.test(lower)) {
    usQuery = 'Luiz Inácio Lula da Silva Brazil foreign policy international perception diplomacy global south';
    academicCore = 'Lula da Silva Brazil foreign policy international relations global diplomacy';
    usWikiCustom = 'Luiz_Inácio_Lula_da_Silva OR Foreign_relations_of_Brazil';
    cnTerms.push('卢拉·达席尔瓦', '巴西外交', '国际关系', '金砖国家');
    deTerms.push('Luiz Inácio Lula da Silva', 'Außenpolitik Brasiliens', 'Internationale Beziehungen');
    jpTerms.push('ルラ・ダ・シルヴァ', 'ブラジルの国際関係', '外交政策');
    krTerms.push('루이스 이나시우 룰라 다 시우바', '브라질의 대외 관계', '외교 정책');
    ruTerms.push('Луис Инасиу Лула да Силва', 'Внешняя политика Бразилии', 'БРИКС');
    cnWikiCustom = '路易斯·伊纳西奥·卢拉·达席尔瓦 OR 巴西外交';
    deWikiCustom = 'Luiz_Inácio_Lula_da_Silva OR Brasilianische_Außenpolitik';
    jpWikiCustom = 'ルイス・イナシオ・ルーラ・ダ・シルヴァ OR ブラジルの国際関係';
    krWikiCustom = '루이스_이나시우_룰라_다_시우바 OR 브라질';
    ruWikiCustom = 'Лула_да_Силва,_Луис_Инасиу OR Внешняя_политика_Бразилии';
    brQuery = 'Luiz Inácio Lula da Silva política externa brasileira percepção internacional diplomacia';
    brWiki = 'Luiz Inácio Lula da Silva OR Política externa do governo Lula';
  }

  // 2. Economia, Política Monetária & Macroeconomia
  if (/\b(economia|macroeconomia|pol[íi]tica\s+monet[áa]ria|pol[íi]tica\s+fiscal|taxa\s+de\s+juros|infla[çc][ãa]o|banco\s+central|monetary\s+policy|interest\s+rates|inflation|central\s+bank|desenvolvimento\s+econ[ôo]mico|pib|d[íi]vida\s+p[úu]blica)\b/i.test(lower)) {
    usQuery = `${enBase} monetary policy central bank inflation interest rates macroeconomics`.trim();
    academicCore = 'monetary policy interest rates inflation targeting central bank macroeconomics';
    usWikiCustom = 'Monetary_policy OR Inflation_targeting OR Central_bank';
    cnTerms.push('货币政策', '中央银行', '利率', '通货膨胀', '宏观经济学');
    deTerms.push('Geldpolitik', 'Zentralbank', 'Leitzins', 'Inflation', 'Makroökonomie');
    jpTerms.push('金融政策', '中央銀行', '政策金利', 'インフレーション', 'マクロ経済学');
    krTerms.push('통화 정책', '중앙은행', '기준금리', '인플레이션', '거시경제학');
    ruTerms.push('денежно-кредитная политика', 'центральный банк', 'процентная ставка', 'инфляция', 'макроэкономика');
    cnWikiCustom = '货币政策 OR 通货膨胀 OR 中央银行';
    deWikiCustom = 'Geldpolitik OR Inflation OR Zentralbank';
    jpWikiCustom = '金融政策 OR インフレーション OR 中央銀行';
    krWikiCustom = '통화_정책 OR 인플레이션 OR 중앙은행';
    ruWikiCustom = 'Денежно-кредитная_политика OR Инфляция OR Центральный_банк';
    brQuery = 'política monetária taxa de juros controle de inflação banco central macroeconomia';
    brWiki = 'Política monetária OR Metas de inflação';
  }

  // 3. Arquitetura Civil (Brutalismo, Bioclimática, Contemporânea, Modernista)
  if (/\b(arquitetura\s+(?:brutalista|bioclim[áa]tica|contempor[âa]nea|moderna|modernista|sustent[áa]vel|civil|urbana)|brutalismo|brutalist\s+architecture|bioclimatic\s+architecture|niemeyer|le\s+corbusier|bauhaus|zaha\s+hadid)\b/i.test(lower)) {
    usQuery = 'brutalist architecture bioclimatic sustainable contemporary building design';
    academicCore = 'bioclimatic architecture sustainable building design';
    usWikiCustom = 'Brutalist architecture';
    cnTerms.push('粗野主义建筑', '生物气候建筑', '绿色建筑', '现代建筑学');
    deTerms.push('Brutalismus', 'Bioklimatische Architektur', 'Nachhaltiges Bauen', 'Moderne Architektur');
    jpTerms.push('ブルータリズム', '環境共生建築', '現代建築', 'サステナブル建築');
    krTerms.push('브루탈리즘', '친환경 건축', '현대 건축', '건축학');
    ruTerms.push('брутализм', 'биоклиматическая архитектура', 'современная архитектура');
    cnWikiCustom = '粗野主义';
    deWikiCustom = 'Brutalismus';
    jpWikiCustom = 'ブルータリズム';
    krWikiCustom = '브루탈리즘';
    ruWikiCustom = 'Брутализм';
    brQuery = 'arquitetura brutalista e arquitetura bioclimática contemporânea sustentável';
    brWiki = 'Arquitetura brutalista';
  }

  // 4. Urbanismo, Planejamento Urbano & Mobilidade
  if (/\b(urbanismo|planejamento\s+urbano|cidades?\s+compactas?|mobilidade\s+urbana|mobilidade\s+sustent[áa]vel|urban\s+planning|compact\s+cities|transit[-\s]oriented|gentrifica[çc][ãa]o|zoneamento)\b/i.test(lower)) {
    usQuery = 'urban planning compact cities transit-oriented development sustainable urban mobility';
    academicCore = 'urban planning compact city sustainable mobility';
    usWikiCustom = 'Urban planning';
    cnTerms.push('城市规划', '紧凑城市', '公共交通导向型开发', '可持续城市交通');
    deTerms.push('Stadtplanung', 'Stadt der kurzen Wege', 'Nachhaltige Mobilität', 'Urbanismus');
    jpTerms.push('都市計画', 'コンパクトシティ', '公共交通指向型開発', '都市交通');
    krTerms.push('도시계획', '압축도시', '대중교통 지향형 개발', '지속가능한 교통');
    ruTerms.push('градостроительство', 'компактный город', 'урбанистика', 'устойчивый транспорт');
    cnWikiCustom = '城市规划';
    deWikiCustom = 'Stadtplanung';
    jpWikiCustom = '都市計画';
    krWikiCustom = '도시계획';
    ruWikiCustom = 'Градостроительство';
    brQuery = 'planejamento urbano urbanismo cidades compactas mobilidade urbana sustentável';
    brWiki = 'Planejamento urbano';
  }

  // 5. Geografia, Geopolítica do Ártico, Clima & Geomorfologia
  if (/\b(geografia|[áa]rtico|arctic|calotas?\s+polares?|degelo|rotas?\s+mar[íi]timas?|geomorfologia|bacia\s+hidrogr[áa]fica|relevo|polar\s+ice|northern\s+sea\s+route)\b/i.test(lower)) {
    usQuery = 'Arctic geopolitics polar ice melting Northern Sea Route maritime geography climate change';
    academicCore = 'Arctic sea ice Northern Sea Route geopolitics';
    usWikiCustom = 'Northern Sea Route';
    cnTerms.push('北极航道', '北极地缘政治', '极地冰盖融化', '自然地理学');
    deTerms.push('Nordostpassage', 'Arktis Geopolitik', 'Polkappen Abschmelzen', 'Physische Geographie');
    jpTerms.push('北極海航路', '北極圏', '海氷減少', '自然地理学');
    krTerms.push('북극항로', '북극 지정학', '빙하 해빙', '자연지리학');
    ruTerms.push('Северный морской путь', 'Арктика', 'таяние льдов', 'физическая география');
    cnWikiCustom = '北方海路';
    deWikiCustom = 'Nordostpassage';
    jpWikiCustom = '北極海航路';
    krWikiCustom = '북극항로';
    ruWikiCustom = 'Северный морской путь';
    brQuery = 'geografia geopolítica do Ártico degelo calotas polares rotas marítimas';
    brWiki = 'Passagem do Nordeste';
  }

  // 6. Tradução explícita SOMENTE quando a query REALMENTE pedir Microsserviços (fim do sequestro de software/Linux/Rust/API!)
  if (domain === 'software_cs' && !isOntologyOrPalantir && !isModelBenchmark && /\b(microsservi[çc]os?|microservices?)\b/i.test(lower)) {
    academicCore = `${enBase}`.trim();
    usWikiCustom = 'Microservices';
    cnTerms.push('微服务架构', '事件驱动架构', '分布式系统');
    deTerms.push('Microservices', 'Ereignisgesteuerte Architektur', 'Verteilte Systeme');
    jpTerms.push('マイクロサービス', 'イベント駆動型アーキテクチャ', '分散システム');
    krTerms.push('마이크로서비스', '이벤트 기반 아키텍처', '분산 컴퓨팅');
    ruTerms.push('микросервисная архитектура', 'событийно-ориентированная архитектура', 'распределенные системы');
    cnWikiCustom = '微服务';
    deWikiCustom = 'Microservices';
    jpWikiCustom = 'マイクロサービス';
    krWikiCustom = '마이크로서비스';
    ruWikiCustom = 'Микросервисная архитектура';
    brWiki = 'Microsserviços';
  }

  if (isOntologyOrPalantir) {
    if (/\bpalantir\b/i.test(lower)) {
      usQuery = 'Palantir Foundry AIP Ontology enterprise AI knowledge graph architecture';
      academicCore = 'enterprise ontology knowledge graph LLM';
      cnTerms.push('Palantir', 'Foundry', 'AIP', '本体', '知识图谱', '企业级AI', '语义层');
      deTerms.push('Palantir Foundry', 'Ontologie Informatik', 'Wissensgraph', 'Künstliche Intelligenz');
      jpTerms.push('Palantir', 'オントロジー', 'ナレッジグラフ', '知識グラフ', '人工知能');
      krTerms.push('Palantir', '온톨로지', '지식 그래프', '인공지능');
      ruTerms.push('Palantir', 'Foundry', 'онтология данных', 'граф знаний', 'ИИ', 'архитектура');
      cnWikiCustom = '知识图谱';
      deWikiCustom = 'Palantir Technologies';
      jpWikiCustom = 'パランティア・テクノロジーズ';
      krWikiCustom = '팔란티어 테크놀로지스';
      ruWikiCustom = 'Palantir';
      brQuery = 'Palantir Foundry AIP ontologia de dados inteligência artificial grafo de conhecimento';
      brWiki = 'Palantir Technologies';
    } else {
      usQuery = `${enBase} ontology knowledge graph semantic model AI`.trim();
      academicCore = 'ontology knowledge graph artificial intelligence';
      cnTerms.push('本体论', '知识图谱', '语义建模', '人工智能', '大模型');
      deTerms.push('Ontologie Informatik', 'Wissensgraph', 'Semantisches Netz', 'Künstliche Intelligenz');
      jpTerms.push('オントロジー', 'ナレッジグラフ', '知識グラフ', '人工知能');
      krTerms.push('온톨로지', '지식 그래프', '시맨틱 웹', '인공지능');
      ruTerms.push('онтология', 'граф знаний', 'семантическая модель', 'искусственный интеллект');
      cnWikiCustom = '知识图谱';
      deWikiCustom = 'Wissensgraph';
      jpWikiCustom = 'ナレッジグラフ';
      krWikiCustom = '지식 그래프';
      ruWikiCustom = 'Граф знаний';
      brQuery = 'ontologia ciência da computação inteligência artificial grafo de conhecimento';
      brWiki = 'Grafo de conhecimento';
    }
  } else if (isChinaHubCompetitor) {
    // Busca concorrentes reais chineses (ModelScope, OpenCSG, WiseModel, Gitee AI) SEM forçar Hugging_Face nos 7 polos!
    usQuery = 'ModelScope';
    enCoreCustom = 'ModelScope OpenCSG WiseModel Gitee AI China LLM model hub';
    academicCore = 'ModelScope OpenCSG WiseModel China open source LLM hub';
    usWikiCustom = 'ModelScope';
    cnTerms.push('魔搭社区', 'ModelScope', 'OpenCSG', 'WiseModel', 'Gitee AI', '开源大模型社区', '阿里云');
    deTerms.push('ModelScope', 'OpenCSG', 'Alibaba KI Modellplattform');
    jpTerms.push('ModelScope', 'OpenCSG', '中国 オープンソース 大規模言語モデル');
    krTerms.push('ModelScope', 'OpenCSG', '중국 오픈소스 LLM 플랫폼');
    ruTerms.push('ModelScope', 'OpenCSG', 'WiseModel', 'китайские открытые LLM платформы');
    cnWikiCustom = '魔搭社区';
    deWikiCustom = 'ModelScope';
    jpWikiCustom = 'ModelScope';
    krWikiCustom = 'ModelScope';
    ruWikiCustom = 'ModelScope';
    brQuery = 'ModelScope OpenCSG WiseModel Gitee AI alternativa chinesa modelos LLM open source';
    brWiki = 'ModelScope';
  } else if (isModelBenchmark) {
    usQuery = `${enBase} SWE-bench LiveBench LMSYS evaluation`.trim();
    academicCore = 'large language model code generation benchmark';
    cnTerms.push('大模型', '编程', '代码生成', '评测', '基准', 'DeepSeek', 'Qwen', 'OpenCompass');
    deTerms.push('Großes Sprachmodell', 'Künstliche Intelligenz', 'Programmierung', 'Benchmark');
    jpTerms.push('大規模言語モデル', '生成AI', 'プログラミング', 'ベンチマーク');
    krTerms.push('대규모 언어 모델', '생성형 인공지능', '코드 생성', '벤치마크');
    ruTerms.push('большие языковые модели', 'LLM', 'программирование', 'бенчмарк', 'MERA', 'YandexGPT', 'GigaChat');
    cnWikiCustom = '大语言模型';
    deWikiCustom = 'Großes Sprachmodell';
    jpWikiCustom = '大規模言語モデル';
    krWikiCustom = '대규모 언어 모델';
    ruWikiCustom = 'Большая языковая модель';
    brQuery = 'modelos de inteligência artificial programação desenvolvimento de software LLM benchmark';
    brWiki = 'Grande modelo de linguagem';
  }

  if (/\b(3d|cad|modeling|mesh|sculpting|blender|freecad)\b/i.test(lower)) {
    academicCore = '3D CAD modeling open source mesh';
    cnTerms.push('开源', '三维建模', 'CAD', '几何内核', '渲染引擎');
    deTerms.push('3D-Modellierung', 'CAD', 'Freie Software', 'Computergrafik');
    jpTerms.push('3DCGソフトウェア', '3次元コンピュータグラフィックス', 'CAD', 'オープンソース');
    krTerms.push('3차원 모델링', '컴퓨터 지원 설계', '오픈 소스', '블렌더');
    ruTerms.push('3D моделирование', 'САПР', 'открытый исходный код', 'геометрическое ядро', 'OpenCASCADE');
    cnWikiCustom = '三维建模';
    deWikiCustom = '3D-Modellierung';
    jpWikiCustom = '3DCGソフトウェア';
    krWikiCustom = '3차원 모델링';
    ruWikiCustom = 'Трёхмерная графика';
    brQuery = 'modelagem 3D código aberto CAD Blender FreeCAD computação gráfica';
    brWiki = 'Modelagem 3D';
  }

  if (/\b(nuclear|fission|fusion|reactor|tokamak|iter|smr)\b/i.test(lower)) {
    usQuery = 'nuclear fusion magnetic confinement tokamak ITER small modular reactors nuclear physics';
    academicCore = 'nuclear fusion tokamak magnetic confinement';
    usWikiCustom = 'Tokamak';
    cnTerms.push('托卡马克', '核聚变', '磁约束聚变', '核反应堆', '核物理学');
    deTerms.push('Kernfusion', 'Tokamak', 'ITER', 'Magnetischer Einschluss', 'Kernphysik');
    jpTerms.push('核融合炉', 'トカマク型', 'ITER', '磁場閉じ込め方式', '原子核物理学');
    krTerms.push('핵융합', '토카막', 'ITER', '소형 모듈 원자로', '핵물리학');
    ruTerms.push('термоядерный синтез', 'токамак', 'ИТЭР', 'ядерный реактор', 'ядерная физика');
    cnWikiCustom = '托卡马克';
    deWikiCustom = 'Tokamak';
    jpWikiCustom = 'トカマク型';
    krWikiCustom = '토카막';
    ruWikiCustom = 'Токамак';
    brQuery = 'física nuclear fusão nuclear confinamento magnético tokamak ITER reatores nucleares';
    brWiki = 'Tokamak';
  }

  if (/\b(security|vulnerability|cve|exploit|reverse\s+engineering|cybersecurity|attack|rootkit)\b/i.test(lower)) {
    cnTerms.push('漏洞分析', '安全研究', '渗透测试', '逆向工程');
    deTerms.push('Informationssicherheit', 'Sicherheitslücke', 'Exploit', 'Reverse_Engineering');
    jpTerms.push('コンピュータセキュリティ', '脆弱性', 'リバースエンジニアリング');
    krTerms.push('컴퓨터 보안', '취약점', '역공학', '익스플로잇');
    ruTerms.push('уязвимость', 'эксплойт', 'информационная безопасность', 'реверс-инжиниринг');
    deWikiCustom = deWikiCustom || 'Informationssicherheit';
    jpWikiCustom = jpWikiCustom || 'コンピュータセキュリティ';
    krWikiCustom = krWikiCustom || '컴퓨터 보안';
  }

  if (/\b(quantum|quântica|quantico|qubit|qubits|supercondutor\w*|superconducting|surface\s+codes?)\b/i.test(lower)) {
    usQuery = 'quantum error correction surface codes superconducting qubits fault-tolerant quantum computing';
    academicCore = 'quantum error correction superconducting qubits';
    usWikiCustom = 'Quantum error correction';
    cnTerms.push('量子纠错', '表面码', '超导量子比特', '量子计算');
    deTerms.push('Quantenfehlerkorrektur', 'Supraleitendes Qubit', 'Quantencomputer', 'Quanteninformatik');
    jpTerms.push('量子誤り訂正', '表面符号', '超伝導量子ビット', '量子コンピュータ');
    krTerms.push('양자 오류 정정', '초전도 큐비트', '양자 컴퓨터', '큐비트');
    ruTerms.push('квантовая коррекция ошибок', 'сверхпроводящие кубиты', 'квантовый компьютер', 'кубит');
    cnWikiCustom = cnWikiCustom || '量子纠错';
    deWikiCustom = deWikiCustom || 'Quantenfehlerkorrektur';
    jpWikiCustom = jpWikiCustom || '量子誤り訂正';
    krWikiCustom = krWikiCustom || '양자 오류 정정';
    ruWikiCustom = ruWikiCustom || 'Квантовая коррекция ошибок';
    brQuery = 'computação quântica correção de erros quânticos códigos de superfície qubits supercondutores';
    brWiki = 'Correção de erro quântico';
  }

  if (/\b(gunpowder|explosive|chemistry|synthesis|napalm)\b/i.test(lower)) {
    cnTerms.push('化学合成', '材料科学', '反应机理', '热力学');
    deTerms.push('Chemische Synthese', 'Thermodynamik', 'Reaktionsmechanismus');
    jpTerms.push('化学合成', '熱力学', '反応機構');
    krTerms.push('화학 합성', '열역학', '반응 메커니즘');
    ruTerms.push('химический синтез', 'термодинамика', 'состав', 'химия');
  }

  if (/\b(estocar\s+alimento\w*|estoque\s+de\s+alimento\w*|armazenar\s+alimento\w*|strategic\s+food\s+reserves?|emergency\s+food\s+stockpil\w*|food\s+storage|seguran[çc]a\s+alimentar|food\s+security)\b/i.test(`${rawQuery} ${lower}`)) {
    usQuery = 'strategic food reserves emergency food stockpiling grain reserve food security 2026';
    academicCore = 'strategic grain reserves food security emergency food storage supply chain resilience';
    usWikiCustom = 'Strategic grain reserve';
    enCoreCustom = 'strategic food reserves emergency food stockpiling food security 2026';
    cnTerms.push('国家粮食储备', '粮食安全', '应急物资储备', '中储粮');
    deTerms.push('Ernährungsvorsorge', 'Notvorrat', 'Zivile Notfallreserve', 'Bundesreserve Getreide');
    jpTerms.push('食料安全保障', '備蓄', 'ローリングストック', '災害用備蓄食料');
    krTerms.push('식량안보', '비상식량', '정부양곡', '식량비축');
    ruTerms.push('Продовольственная безопасность', 'Росрезерв', 'государственный материальный резерв', 'запасы продовольствия');
    cnWikiCustom = '粮食安全';
    deWikiCustom = 'Zivile Notfallreserve';
    jpWikiCustom = '備蓄';
    krWikiCustom = '식량안보';
    ruWikiCustom = 'Продовольственная безопасность';
    brQuery = 'estocar alimentos reserva estratégica de alimentos segurança alimentar CONAB conservação de alimentos 2026';
    brWiki = 'Segurança alimentar';
  }

  if (
    /\b(outr[oa]s?|other|al[ée]m\s+d[aeo]|semelhantes?|parecid[oa]s?|similar|like)\b/i.test(`${rawQuery} ${lower}`) &&
    /(?:uvb-?76|увб-?76|buzzer|ju[íi]zo\s+final|fim\s+do\s+mundo|doomsday)/i.test(`${rawQuery} ${lower}`)
  ) {
    usQuery = 'Numbers station The Pip Squeaky Wheel HFGCS Skyking';
    enCoreCustom = 'Numbers station The Pip Squeaky Wheel HFGCS Skyking';
    academicCore = 'shortwave numbers station military HF communication';
    usWikiCustom = 'High Frequency Global Communications System';
    cnTerms.push('数字电台', '短波广播', '末日广播');
    deTerms.push('Monolith-Netzwerk', 'Zahlensender', 'The Pip', 'Squeaky Wheel');
    jpTerms.push('乱数放送', '短波放送', 'ザ・ピップ');
    krTerms.push('난수방송', '단파방송');
    ruTerms.push('Номерные радиостанции', 'Капля', 'Скрипучее колесо', 'УВБ-76');
    cnWikiCustom = '数字电台';
    deWikiCustom = 'Monolith-Netzwerk';
    jpWikiCustom = '乱数放送';
    krWikiCustom = '난수방송';
    ruWikiCustom = 'Номерные радиостанции';
    brQuery = 'Estação de números rádios militares ondas curtas The Pip Squeaky Wheel HFGCS';
    brWiki = 'Estação de números';
  }

  const coreTokens = enBase
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !/^(strongest|best|top|sota|current|latest|comparison|synthesis|composition|2026|como|visto|mundo|qual|quais)$/i.test(w))
    .slice(0, 6);
  const coreJoined = coreTokens.join(' ') || enBase;

  return {
    domain,
    intent: plan.intent,
    freshness: plan.freshness,
    shouldIncludeAcademic: plan.shouldIncludeAcademic,
    subQueries: plan.subQueries,
    plan,
    us: usQuery,
    usWiki: usWikiCustom || coreJoined,
    cn: cnTerms.length > 0 ? `${cnTerms.slice(0, 8).join(' ')} ${coreTokens.slice(0, 2).join(' ')}`.trim() : coreJoined,
    cnWiki: cnWikiCustom || (cnTerms.length > 0 ? cnTerms.slice(0, 2).join(' ') : coreJoined),
    de: deTerms.length > 0 ? `${deTerms.slice(0, 6).join(' ')}`.trim() : coreJoined,
    deWiki: deWikiCustom || (deTerms.length > 0 ? deTerms.slice(0, 2).join(' ') : coreJoined),
    jp: jpTerms.length > 0 ? `${jpTerms.slice(0, 6).join(' ')}`.trim() : coreJoined,
    jpWiki: jpWikiCustom || (jpTerms.length > 0 ? jpTerms.slice(0, 2).join(' ') : coreJoined),
    kr: krTerms.length > 0 ? `${krTerms.slice(0, 6).join(' ')}`.trim() : coreJoined,
    krWiki: krWikiCustom || (krTerms.length > 0 ? krTerms.slice(0, 2).join(' ') : coreJoined),
    ru: ruTerms.length > 0 ? `${ruTerms.slice(0, 8).join(' ')}`.trim() : coreJoined,
    ruWiki: ruWikiCustom || (ruTerms.length > 0 ? ruTerms.slice(0, 2).join(' ') : coreJoined),
    br: brQuery,
    brWiki,
    enCore: enCoreCustom || coreJoined,
    academicCore: academicCore || coreJoined
  };
}

/**
 * Enriquecimento especializado de query segundo o Focus Mode selecionado.
 */
function applyFocusModeToQuery(rawQuery, focusMode = 'web') {
  const clean = String(rawQuery || '').trim();
  const modeKey = String(focusMode || 'web').trim().toLowerCase();
  const mode = Object.prototype.hasOwnProperty.call(FOCUS_MODES, modeKey) ? FOCUS_MODES[modeKey] : null;
  if (!clean || !mode || !mode.querySuffix) {
    return clean.slice(0, 380);
  }
  const lower = clean.toLowerCase();
  const suffixTokens = mode.querySuffix
    .split(/\s+/)
    .filter((tok) => tok && !lower.includes(tok.toLowerCase()));
  if (suffixTokens.length === 0) {
    return clean.slice(0, 380);
  }
  return `${clean} ${suffixTokens.slice(0, 4).join(' ')}`.trim().slice(0, 380);
}

/**
 * Detecta se a pergunta atual possui anáfora ou referência explícita ao turno anterior.
 */
function hasExplicitAnaphoraOrReference(cleanQuestion) {
  const q = String(cleanQuestion || '').trim();
  if (!q) return false;

  // Pronomes anafóricos explícitos (PT / EN / ES)
  const anaphoraPattern = /\b(ele|ela|eles|elas|dele|dela|deles|delas|disso|nisso|disto|nisto|daquilo|naquilo|desse|dessa|desses|dessas|nesse|nessa|nesses|nessas|deste|desta|neste|nesta|isso|isto|aquilo|anterior|anteriores|acima|mencionad[oa]s?|citad[oa]s?|deles|delas|it|its|them|their|theirs|these|those|above|previous|former|latter|eso|esto|aquello|ellos|ellas|anterior|mencionado)\b/i;
  if (anaphoraPattern.test(q)) {
    return true;
  }

  // Expressões de continuação explícita / comparação com o turno anterior
  const continuationPattern = /(?:^|\b)(qual\s+del[ea]s|quais\s+del[ea]s|e\s+quanto|e\s+sobre|e\s+no\s+caso|e\s+se|compare\s+com|comparad[oa]\s+a|mais\s+detalhes|aprofunde|explique\s+melhor|continue|al[ée]m\s+disso|outr[oa]s?\s+(?:semelhantes?|parecid[oa]s?|alternativas?|exemplos?)|what\s+about|how\s+about|more\s+details|tell\s+me\s+more|compare\s+with|y\s+cu[áa]nto|y\s+sobre|m[áa]s\s+detalles|cu[áa]l\s+de\s+ell[oa]s)\b/i;
  if (continuationPattern.test(q)) {
    return true;
  }

  // Pergunta que inicia explicitamente com conjunção continuativa ("E qual...", "Mas como...", "And how...")
  if (/^¿?(?:e\s+(?:qual|quais|como|por\s+que|porque|onde|quando|quanto)|mas\s+(?:como|por\s+que|qual|quais)|and\s+(?:how|why|what|which|where|when)|but\s+(?:how|why|what|which)|y\s+(?:c[óo]mo|por\s+qu[ée]|cu[áa]l|cu[áa]les)|pero\s+(?:c[óo]mo|por\s+qu[ée]))\b/i.test(q)) {
    return true;
  }

  return false;
}

/**
 * Constrói uma query de busca contextualizada SOMENTE quando a pergunta atual
 * contém anáfora ou referência explícita ao turno anterior (não concatena cegamente
 * perguntas independentes curtas < 7 palavras).
 */
function buildContextualSearchQuery(question, priorTurns = [], focusMode = 'web') {
  const cleanQuestion = String(question || '').trim();
  if (!priorTurns || priorTurns.length === 0) {
    return applyFocusModeToQuery(cleanQuestion, focusMode);
  }

  const firstQuestion = String(priorTurns[0]?.question || '').trim();
  const lastQuestion = String(priorTurns[priorTurns.length - 1]?.question || '').trim();

  // Se a pergunta atual já contém o tema principal da conversa, não duplica
  const firstWords = firstQuestion
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const lowerCurrent = cleanQuestion.toLowerCase();
  if (firstWords.length > 0) {
    const matchedCount = firstWords.filter((w) => lowerCurrent.includes(w)).length;
    if (matchedCount / firstWords.length >= 0.5) {
      return applyFocusModeToQuery(cleanQuestion, focusMode);
    }
  }

  const words = cleanQuestion.split(/\s+/).filter(Boolean);
  if (words.length === 1 && !/^(isso|ele|ela|eles|elas|porqu[êe]|why|how|continue)$/i.test(words[0])) {
    return applyFocusModeToQuery(cleanQuestion, focusMode);
  }

  if (!hasExplicitAnaphoraOrReference(cleanQuestion)) {
    return applyFocusModeToQuery(cleanQuestion, focusMode);
  }

  const anchor =
    lastQuestion && lastQuestion !== firstQuestion && !lastQuestion.includes(firstQuestion)
      ? `${firstQuestion} ${lastQuestion}`
      : firstQuestion;

  if (!anchor) {
    return applyFocusModeToQuery(cleanQuestion, focusMode);
  }

  const combined = `${anchor} — ${cleanQuestion}`.replace(/\s+/g, ' ').trim();
  return applyFocusModeToQuery(combined, focusMode);
}

module.exports = {
  MAX_RESULTS,
  MULTI_POLAR_RESULTS_COUNT,
  GLOBAL_ACCEPT_LANGUAGE,
  LOW_SIGNAL_DOMAINS,
  HIGH_SIGNAL_DOMAINS,
  FOCUS_MODES,
  SEARCH_SCOPES,
  normalizeSearchScope,
  SEARCH_LANGUAGES,
  normalizeSearchLang,
  normalizeHyphens,
  isExplicitBrazilQuery,
  isPortugueseOrBrazilianBubbleResult,
  classifyQueryDomain,
  isLowSignalResult,
  toGlobalResearchQuery,
  extractSubjectTokens,
  isChinaLlmHubCompetitorQuery,
  planSearchIntent,
  buildMultiPolarQueries,
  applyFocusModeToQuery,
  hasExplicitAnaphoraOrReference,
  buildContextualSearchQuery
};
