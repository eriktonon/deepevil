'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { Agent, buildConnector } = require('undici');

const FORBIDDEN_HOSTNAMES = new Set([
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

const FORBIDDEN_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain'
];

function createSecurityError(message, code = 'ERR_SSRF_BLOCKED') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeIpLiteral(rawIp) {
  if (typeof rawIp !== 'string') return '';
  let clean = rawIp.trim().toLowerCase();
  if (!clean) return '';
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx !== -1) {
    clean = clean.slice(0, zoneIdx);
  }
  return clean;
}

function parseIpv4Octets(ip) {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

function isPrivateOrReservedIpv4Octets(octets) {
  if (!octets || octets.length !== 4) return true;
  const [a, b] = octets;
  if (a === 0) return true;                           // 0.0.0.0/8 (This network)
  if (a === 10) return true;                          // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT RFC 6598)
  if (a === 127) return true;                         // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (Link-local / Cloud IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16 (RFC 1918)
  if (a >= 224 && a <= 239) return true;              // 224.0.0.0/4 (Multicast)
  if (a >= 240) return true;                          // 240.0.0.0/4 (Reserved / Broadcast)
  return false;
}

function parseIpv6Words(ip) {
  if (!net.isIPv6(ip)) return null;
  let normalized = ip.toLowerCase();

  // Handle embedded IPv4 tail (e.g., ::ffff:127.0.0.1, 64:ff9b::10.0.0.1)
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4Str = normalized.slice(lastColon + 1);
    const octets = parseIpv4Octets(v4Str);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  let groups;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...new Array(missing).fill('0'), ...right];
  } else {
    groups = normalized.split(':');
    if (groups.length !== 8) return null;
  }

  const words = new Array(8);
  for (let i = 0; i < 8; i++) {
    const val = Number.parseInt(groups[i], 16);
    if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null;
    words[i] = val;
  }
  return words;
}

function wordsToIpv4Octets(wHi, wLo) {
  return [(wHi >> 8) & 0xff, wHi & 0xff, (wLo >> 8) & 0xff, wLo & 0xff];
}

/**
 * Retorna true se o IP (IPv4 ou IPv6) pertencer a uma faixa privada, loopback,
 * link-local, CGNAT, multicast, reservada, ou se for inválido (fail-closed).
 */
function isPrivateOrReservedIp(ip) {
  const clean = normalizeIpLiteral(ip);
  if (!clean) return true;

  const ipVersion = net.isIP(clean);
  if (ipVersion === 4) {
    const octets = parseIpv4Octets(clean);
    return isPrivateOrReservedIpv4Octets(octets);
  }

  if (ipVersion === 6) {
    const w = parseIpv6Words(clean);
    if (!w) return true;

    // :: (unspecified)
    if (w.every((n) => n === 0)) return true;

    // ::1 (loopback)
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0 && w[6] === 0 && w[7] === 1) {
      return true;
    }

    // IPv4-mapped ::ffff:0:0/96
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
      return isPrivateOrReservedIpv4Octets(wordsToIpv4Octets(w[6], w[7]));
    }

    // IPv4-translated ::ffff:0:0:0/96
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0) {
      return isPrivateOrReservedIpv4Octets(wordsToIpv4Octets(w[6], w[7]));
    }

    // Deprecated IPv4-compatible ::/96
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
      return isPrivateOrReservedIpv4Octets(wordsToIpv4Octets(w[6], w[7]));
    }

    // NAT64 well-known prefix 64:ff9b::/96
    if (w[0] === 0x0064 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
      return isPrivateOrReservedIpv4Octets(wordsToIpv4Octets(w[6], w[7]));
    }

    // 6to4 2002::/16 (embedded IPv4 in w[1], w[2])
    if (w[0] === 0x2002) {
      return isPrivateOrReservedIpv4Octets(wordsToIpv4Octets(w[1], w[2]));
    }

    // Unique local fc00::/7
    if ((w[0] & 0xfe00) === 0xfc00) return true;

    // Link-local fe80::/10
    if ((w[0] & 0xffc0) === 0xfe80) return true;

    // Deprecated site-local fec0::/10
    if ((w[0] & 0xffc0) === 0xfec0) return true;

    // Multicast ff00::/8
    if ((w[0] & 0xff00) === 0xff00) return true;

    return false;
  }

  // Fail-closed for any non-IP / malformed input
  return true;
}

function normalizeHostname(rawHostname) {
  return String(rawHostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

function isForbiddenHostname(hostname) {
  const clean = normalizeHostname(hostname);
  if (!clean) return true;
  if (FORBIDDEN_HOSTNAMES.has(clean)) return true;
  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (clean.endsWith(suffix)) return true;
  }
  return false;
}

async function resolveDnsRecords(hostname, lookupFn) {
  const fn = lookupFn || dns.promises.lookup;

  // Support both Promise-based (dns.promises.lookup) and callback-based (dns.lookup) functions
  let raw;
  if (fn === dns.lookup) {
    raw = await new Promise((resolve, reject) => {
      dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
  } else {
    raw = await fn(hostname, { all: true, verbatim: true });
  }

  let list;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object' && typeof raw.address === 'string') {
    list = [raw];
  } else if (typeof raw === 'string') {
    list = [{ address: raw, family: net.isIP(raw) }];
  } else {
    list = [];
  }

  return list
    .filter((rec) => rec && typeof rec.address === 'string' && rec.address.trim())
    .map((rec) => {
      const address = normalizeIpLiteral(rec.address);
      const family = Number(rec.family) || net.isIP(address);
      return { address, family };
    })
    .filter((rec) => rec.family === 4 || rec.family === 6);
}

/**
 * Valida uma URL de saída contra SSRF (protocolo http/https, hostname proibido,
 * IP literal privado/reservado e resolução DNS verificando todos os registros A/AAAA).
 */
async function assertSafeOutboundUrl(rawUrl, options = {}) {
  const str = String(rawUrl || '').trim();
  if (!str || /[\u0000-\u001f\u007f]/.test(str)) {
    throw createSecurityError('URL de saída inválida ou contendo caracteres de controle.', 'ERR_SSRF_INVALID_URL');
  }

  let parsed;
  try {
    parsed = new URL(str);
  } catch (_) {
    throw createSecurityError('URL de saída malformada.', 'ERR_SSRF_INVALID_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createSecurityError(`Protocolo bloqueado para requisição externa: ${parsed.protocol}`, 'ERR_SSRF_BLOCKED_PROTOCOL');
  }

  if (!options.allowCredentials && (parsed.username || parsed.password)) {
    throw createSecurityError('Credenciais embutidas na URL externa são proibidas.', 'ERR_SSRF_BLOCKED_CREDENTIALS');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw createSecurityError('Hostname vazio na URL externa.', 'ERR_SSRF_INVALID_URL');
  }

  if (isForbiddenHostname(hostname)) {
    throw createSecurityError(`Hostname interno/reservado bloqueado: ${hostname}`, 'ERR_SSRF_BLOCKED');
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw createSecurityError(`Endereço IP privado/reservado bloqueado: ${hostname}`, 'ERR_SSRF_BLOCKED');
    }
    return {
      url: parsed.toString(),
      hostname,
      resolvedAddress: hostname,
      family: literalFamily
    };
  }

  if (options.signal?.aborted) {
    throw createSecurityError('Validação SSRF abortada.', 'ABORT_ERR');
  }

  let records;
  try {
    records = await resolveDnsRecords(hostname, options.lookupFn);
  } catch (err) {
    if (err && String(err.code || '').startsWith('ERR_SSRF')) {
      throw err;
    }
    throw createSecurityError(`Falha na resolução DNS para ${hostname}: ${err?.message || String(err)}`, 'ERR_SSRF_DNS_FAILED');
  }

  if (!records || records.length === 0) {
    throw createSecurityError(`Nenhum registro DNS válido retornado para ${hostname}.`, 'ERR_SSRF_DNS_EMPTY');
  }

  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw createSecurityError(
        `SSRF bloqueado: ${hostname} resolveu para IP privado/reservado (${rec.address}).`,
        'ERR_SSRF_BLOCKED'
      );
    }
  }

  const preferred = records.find((r) => r.family === 4) || records[0];
  return {
    url: parsed.toString(),
    hostname,
    resolvedAddress: preferred.address,
    family: preferred.family
  };
}

/**
 * Cria um undici.Agent seguro com TLS estrito (rejectUnauthorized: true)
 * e validação DNS/IP no momento da conexão (impede DNS Rebinding TOCTOU e
 * bloqueia redirecionamentos ou IPs literais para redes privadas/internas).
 */
function createSafeHttpDispatcher(options = {}) {
  const timeout = Number.isFinite(Number(options.timeout)) ? Number(options.timeout) : 6500;
  const lookupFn = options.lookupFn || null;

  const safeLookup = (hostname, lookupOpts, callback) => {
    let opts = lookupOpts;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    const cleanHost = normalizeHostname(hostname);
    if (!cleanHost || isForbiddenHostname(cleanHost)) {
      cb(createSecurityError(`Hostname interno/reservado bloqueado no connect: ${hostname}`, 'ERR_SSRF_BLOCKED'));
      return;
    }

    const literalFamily = net.isIP(cleanHost);
    if (literalFamily !== 0) {
      if (isPrivateOrReservedIp(cleanHost)) {
        cb(createSecurityError(`IP privado/reservado bloqueado no connect: ${cleanHost}`, 'ERR_SSRF_BLOCKED'));
        return;
      }
      if (opts && opts.all) {
        cb(null, [{ address: cleanHost, family: literalFamily }]);
      } else {
        cb(null, cleanHost, literalFamily);
      }
      return;
    }

    resolveDnsRecords(cleanHost, lookupFn)
      .then((records) => {
        if (!records || records.length === 0) {
          cb(createSecurityError(`Nenhum registro DNS válido para ${cleanHost}.`, 'ERR_SSRF_DNS_EMPTY'));
          return;
        }
        for (const rec of records) {
          if (isPrivateOrReservedIp(rec.address)) {
            cb(
              createSecurityError(
                `DNS Rebinding / SSRF bloqueado no connect: ${cleanHost} -> ${rec.address}`,
                'ERR_SSRF_BLOCKED'
              )
            );
            return;
          }
        }
        if (opts && opts.all) {
          const requestedFamily = Number(opts.family);
          const filtered = (requestedFamily === 4 || requestedFamily === 6)
            ? records.filter((r) => r.family === requestedFamily)
            : records;
          if (filtered.length === 0) {
            cb(createSecurityError(`Nenhum endereço IPv${requestedFamily} público para ${cleanHost}.`, 'ERR_SSRF_DNS_EMPTY'));
            return;
          }
          cb(null, filtered);
        } else {
          const requestedFamily = Number(opts?.family);
          const chosen = (requestedFamily === 4 || requestedFamily === 6)
            ? records.find((r) => r.family === requestedFamily)
            : (records.find((r) => r.family === 4) || records[0]);
          if (!chosen) {
            cb(createSecurityError(`Nenhum endereço público compatível para ${cleanHost}.`, 'ERR_SSRF_DNS_EMPTY'));
            return;
          }
          cb(null, chosen.address, chosen.family);
        }
      })
      .catch((err) => {
        cb(err);
      });
  };

  // Enforces rejectUnauthorized: true unconditionally (ignores any insecure override in options)
  const innerConnector = buildConnector({
    timeout,
    rejectUnauthorized: true,
    lookup: safeLookup,
    autoSelectFamily: false
  });

  const safeConnect = (connectOpts, callback) => {
    const cleanHost = normalizeHostname(connectOpts?.hostname);
    if (!cleanHost || isForbiddenHostname(cleanHost)) {
      callback(createSecurityError(`Hostname bloqueado na conexão TCP/TLS: ${connectOpts?.hostname}`, 'ERR_SSRF_BLOCKED'), null);
      return;
    }
    const literalFamily = net.isIP(cleanHost);
    if (literalFamily !== 0 && isPrivateOrReservedIp(cleanHost)) {
      callback(createSecurityError(`IP privado/reservado bloqueado na conexão TCP/TLS: ${cleanHost}`, 'ERR_SSRF_BLOCKED'), null);
      return;
    }
    innerConnector(connectOpts, callback);
  };

  const agentOptions = {
    connect: safeConnect
  };
  if (Number.isFinite(Number(options.headersTimeout))) {
    agentOptions.headersTimeout = Number(options.headersTimeout);
  }
  if (Number.isFinite(Number(options.bodyTimeout))) {
    agentOptions.bodyTimeout = Number(options.bodyTimeout);
  }
  if (Number.isFinite(Number(options.connections))) {
    agentOptions.connections = Number(options.connections);
  }
  if (Number.isFinite(Number(options.keepAliveTimeout))) {
    agentOptions.keepAliveTimeout = Number(options.keepAliveTimeout);
  }

  return new Agent(agentOptions);
}

/**
 * Validação fail-closed de endereço de origem loopback (127.0.0.0/8, ::1, ::ffff:127.x.x.x).
 * Quando allowDockerBridge === true, permite também a faixa Docker bridge 172.16.0.0/12.
 */
function isLoopbackAddress(remoteAddress, allowDockerBridge = false) {
  if (!remoteAddress || typeof remoteAddress !== 'string') return false;
  const clean = normalizeIpLiteral(remoteAddress);
  if (!clean) return false;

  const version = net.isIP(clean);
  if (version === 4) {
    const octets = parseIpv4Octets(clean);
    if (!octets) return false;
    if (octets[0] === 127) return true;
    if (allowDockerBridge && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    return false;
  }

  if (version === 6) {
    const w = parseIpv6Words(clean);
    if (!w) return false;
    // ::1
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0 && w[6] === 0 && w[7] === 1) {
      return true;
    }
    // IPv4-mapped ::ffff:a.b.c.d
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
      const octets = wordsToIpv4Octets(w[6], w[7]);
      if (octets[0] === 127) return true;
      if (allowDockerBridge && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    }
    return false;
  }

  return false;
}

function parseHostHeaderParts(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') return null;
  const clean = rawHost.trim().toLowerCase();
  if (!clean || /[\s/\\@\u0000-\u001f\u007f]/.test(clean)) return null;

  // Bracketed IPv6: [::1] or [::1]:3000
  const v6Match = clean.match(/^(\[[^\]]+\])(?::(\d{1,5}))?$/);
  if (v6Match) {
    const portStr = v6Match[2] || null;
    if (portStr) {
      const p = Number.parseInt(portStr, 10);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
    }
    return { host: v6Match[1], port: portStr, full: clean };
  }

  // Hostname or IPv4: localhost, 127.0.0.1:3000
  const hostMatch = clean.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!hostMatch) return null;
  const portStr = hostMatch[2] || null;
  if (portStr) {
    const p = Number.parseInt(portStr, 10);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  }
  return { host: hostMatch[1], port: portStr, full: clean };
}

function getExtraAllowedHosts(envOrList) {
  if (Array.isArray(envOrList)) {
    return envOrList.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
  }
  const raw = String(envOrList?.ALLOWED_HOSTS ?? process.env.ALLOWED_HOSTS ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Allowlist estrita do cabeçalho Host contra DNS Rebinding.
 * Permite localhost, 127.0.0.1, [::1] (com ou sem :port) e entradas em ALLOWED_HOSTS.
 */
function isAllowedHostHeader(hostHeader, port = null, envOrExtras = process.env) {
  const parsed = parseHostHeaderParts(hostHeader);
  if (!parsed) return false;

  const extras = getExtraAllowedHosts(envOrExtras);
  if (extras.includes(parsed.full) || extras.includes(parsed.host)) {
    return true;
  }

  const baseHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!baseHosts.has(parsed.host)) {
    return false;
  }

  // Sem porta no header Host (ex.: "localhost" ou "127.0.0.1")
  if (!parsed.port) {
    return true;
  }

  // Se uma porta esperada não foi informada, aceita qualquer porta numérica válida (1..65535)
  if (port === null || port === undefined || port === '') {
    return true;
  }

  const expectedPorts = new Set([String(port).trim()]);
  const envObj = envOrExtras && !Array.isArray(envOrExtras) ? envOrExtras : null;
  if (
    envObj &&
    String(envObj.ALLOW_DOCKER_BRIDGE || '').trim().toLowerCase() === 'true' &&
    envObj.HOST_PORT
  ) {
    expectedPorts.add(String(envObj.HOST_PORT).trim());
  }

  return expectedPorts.has(parsed.port);
}

/**
 * Proteção CSRF para rotas mutáveis (POST, DELETE, PUT, PATCH).
 * Permite chamadas CLI/non-browser sem Origin/Referer e sem Sec-Fetch-Site cross-site;
 * bloqueia Origin/Referer externo, Origin: null e Sec-Fetch-Site: cross-site.
 */
function isAllowedOrigin(req, env = process.env) {
  if (!req || !req.headers) return false;

  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }

  const localPort = req.socket?.localPort ?? null;
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    if (origin.toLowerCase() === 'null') {
      return false;
    }
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
        return false;
      }
      return isAllowedHostHeader(parsedOrigin.host, localPort, env);
    } catch (_) {
      return false;
    }
  }

  const referer = String(req.headers.referer || '').trim();
  if (referer) {
    try {
      const parsedReferer = new URL(referer);
      if (parsedReferer.protocol !== 'http:' && parsedReferer.protocol !== 'https:') {
        return false;
      }
      return isAllowedHostHeader(parsedReferer.host, localPort, env);
    } catch (_) {
      return false;
    }
  }

  // Sem Origin, sem Referer e sem Sec-Fetch-Site: cross-site (CLI, SDK Rust, testes HTTP)
  return true;
}

/**
 * Sanitiza URLs para atributos href, permitindo estritamente http: e https:.
 * Retorna '#' para javascript:, data:, vbscript:, file: ou URLs inválidas.
 */
function safeHttpUrl(rawUrl) {
  const str = String(rawUrl ?? '').trim();
  if (!str || /[\u0000-\u001f\u007f]/.test(str)) return '#';
  try {
    const parsed = new URL(str);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '#';
    }
    return parsed.toString();
  } catch (_) {
    return '#';
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Codifica payload em linhas `data: ...` conforme a spec WHATWG EventSource,
 * preservando quebras de linha (\n) em blocos <pre><code> e neutralizando bare \r
 * contra injeção de eventos SSE.
 */
function sanitizeSseDataLines(payload) {
  const normalized = String(payload ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  return normalized
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
}

/**
 * Valida código de idioma contra mapa/coleção suportada (imune a prototype pollution).
 * Retorna a chave canônica válida ou null.
 */
function validateTargetLang(lang, supportedMap) {
  const clean = String(lang ?? '').trim();
  if (!clean || !supportedMap) return null;

  if (supportedMap instanceof Set) {
    if (supportedMap.has(clean)) return clean;
    const lower = clean.toLowerCase();
    for (const key of supportedMap) {
      if (String(key).toLowerCase() === lower) return key;
    }
    return null;
  }

  if (Array.isArray(supportedMap)) {
    const lower = clean.toLowerCase();
    const found = supportedMap.find((k) => String(k).toLowerCase() === lower);
    return found || null;
  }

  if (typeof supportedMap === 'object') {
    if (Object.prototype.hasOwnProperty.call(supportedMap, clean)) {
      return clean;
    }
    const lower = clean.toLowerCase();
    const keys = Object.keys(supportedMap);
    const match = keys.find((k) => k.toLowerCase() === lower);
    return match || null;
  }

  return null;
}

/**
 * Faz parse seguro de inteiro positivo com limites [min, max], evitando NaN.
 */
function parsePositiveInt(val, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (val === undefined || val === null || val === '') return fallback;
  const str = typeof val === 'string' ? val.trim() : String(val);
  if (!/^-?\d+$/.test(str)) return fallback;
  const parsed = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  const lower = Number.isSafeInteger(min) ? min : 1;
  const upper = Number.isSafeInteger(max) ? max : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, lower), upper);
}

/**
 * Envolve handlers async do Express 4 para propagar rejeições ao error middleware global.
 */
function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  isPrivateOrReservedIp,
  assertSafeOutboundUrl,
  createSafeHttpDispatcher,
  isLoopbackAddress,
  isAllowedHostHeader,
  isAllowedOrigin,
  safeHttpUrl,
  escapeHtml,
  sanitizeSseDataLines,
  validateTargetLang,
  parsePositiveInt,
  asyncHandler
};
