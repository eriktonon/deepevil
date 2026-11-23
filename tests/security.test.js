'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');

const { createDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const {
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
  parsePositiveInt
} = require('../src/security');
const { extractReadablePage, buildSnippetFallbackSource } = require('../src/extractor');
const { renderAnswerMarkdownWithFootnotes } = require('../src/render');
const { SUPPORTED_TRANSLATION_LANGUAGES } = require('../src/llm');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function rawHttpRequest({ port, method = 'GET', reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8')
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function createNoopQdrant(overrides = {}) {
  return {
    checkHealth: async () => ({ online: true, collection: 'deepevil_conversations_v2', vectorSize: 1024 }),
    indexTurn: async () => true,
    deleteConversationPoints: async () => true,
    searchKnowledge: async () => [],
    searchHybridSources: async () => [],
    ...overrides
  };
}

// ============================================================================
// APP-01: SSRF Protection (IPv4/IPv6/DNS/Redirects/Content-Type/Snippet)
// ============================================================================
test('APP-01.1: isPrivateOrReservedIp bloqueia faixas privadas/reservadas/loopback/IMDS/IPv6 e permite IPs públicos', () => {
  const blockedIps = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.3.1',
    '192.168.3.216',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '[::1]',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:192.168.3.1',
    '::ffff:0:127.0.0.1',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1',
    '2002:7f00:0001::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456:789a::1',
    'fec0::1',
    'ff02::1',
    '',
    null,
    undefined,
    'not-an-ip'
  ];

  for (const ip of blockedIps) {
    assert.equal(isPrivateOrReservedIp(ip), true, `Esperava bloqueio para IP/valor: ${String(ip)}`);
  }

  const publicIps = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888'
  ];

  for (const ip of publicIps) {
    assert.equal(isPrivateOrReservedIp(ip), false, `Esperava permissão para IP público: ${ip}`);
  }
});

test('APP-01.2: assertSafeOutboundUrl bloqueia IPs privados, hostnames internos, protocolos perigosos e DNS rebinding', async () => {
  const forbiddenUrls = [
    'http://127.0.0.1/',
    'http://10.0.0.1/admin',
    'http://172.16.0.1/',
    'http://192.168.3.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:3000/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:3000/',
    'http://sub.localhost/',
    'http://host.docker.internal:11434/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://service.local/',
    'http://2130706433/',
    'http://0x7f000001/',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/',
    'javascript:alert(1)',
    'http://user:pass@example.org/',
    'http://example.org/\r\nInjected: 1',
    'not-a-url'
  ];

  for (const u of forbiddenUrls) {
    await assert.rejects(
      () => assertSafeOutboundUrl(u),
      (err) => Boolean(err && String(err.code || '').startsWith('ERR_SSRF')),
      `assertSafeOutboundUrl deveria rejeitar ${u}`
    );
  }

  // DNS retornando IP privado (mesmo em resposta multi-registro A/AAAA)
  await assert.rejects(
    () =>
      assertSafeOutboundUrl('https://rebind.attacker.example/data', {
        lookupFn: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 }
        ]
      }),
    (err) => err.code === 'ERR_SSRF_BLOCKED'
  );

  // DNS vazio -> fail-closed
  await assert.rejects(
    () =>
      assertSafeOutboundUrl('https://nxdomain.example/', {
        lookupFn: async () => []
      }),
    (err) => err.code === 'ERR_SSRF_DNS_EMPTY'
  );

  // URL pública com DNS resolvendo exclusivamente para IP público -> permitida
  const ok = await assertSafeOutboundUrl('https://docs.example.org/guide', {
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(ok.hostname, 'docs.example.org');
  assert.equal(ok.resolvedAddress, '93.184.216.34');
  assert.equal(ok.family, 4);

  // IP literal público -> permitido sem DNS
  const okIp = await assertSafeOutboundUrl('https://1.1.1.1/dns-query');
  assert.equal(okIp.resolvedAddress, '1.1.1.1');
});

test('APP-01.3: extractReadablePage bloqueia alvos internos, redirects 302 para 127.0.0.1/IMDS e respostas sem Content-Type', async () => {
  const internalTargets = [
    'http://127.0.0.1:3000/health',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.3.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:3000/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:8888/',
    'http://host.docker.internal:11434/'
  ];

  let networkCallsOnInternal = 0;
  for (const target of internalTargets) {
    const res = await extractReadablePage(target, 'Internal Probe', {
      requestFn: async () => {
        networkCallsOnInternal += 1;
        throw new Error('Nunca deveria atingir requestFn para alvo SSRF');
      }
    });
    assert.equal(res, null, `extractReadablePage deve bloquear ${target}`);
  }
  assert.equal(networkCallsOnInternal, 0, 'Nenhuma chamada HTTP deve sair para IPs/hosts internos');

  // Redirect 302 de domínio público -> 127.0.0.1
  const calledUrlsLocal = [];
  const redirectToLoopback = await extractReadablePage('https://public-redirect.example/hop', 'Redirect Test', {
    requestFn: async (url) => {
      calledUrlsLocal.push(url);
      if (url.includes('public-redirect.example')) {
        return {
          statusCode: 302,
          headers: { location: 'http://127.0.0.1:3000/health' },
          body: { dump: async () => {} }
        };
      }
      throw new Error('Redirect SSRF para 127.0.0.1 não foi bloqueado!');
    }
  });
  assert.equal(redirectToLoopback, null);
  assert.deepEqual(calledUrlsLocal, ['https://public-redirect.example/hop']);

  // Redirect 302 de domínio público -> 169.254.169.254 (Cloud IMDS)
  const calledUrlsImds = [];
  const redirectToImds = await extractReadablePage('https://public-redirect.example/imds', 'IMDS Redirect', {
    requestFn: async (url) => {
      calledUrlsImds.push(url);
      if (url.includes('public-redirect.example')) {
        return {
          statusCode: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
          body: { dump: async () => {} }
        };
      }
      throw new Error('Redirect SSRF para 169.254.169.254 não foi bloqueado!');
    }
  });
  assert.equal(redirectToImds, null);
  assert.deepEqual(calledUrlsImds, ['https://public-redirect.example/imds']);

  // Rejeição de resposta sem Content-Type (previne sniffing / binários)
  const noContentType = await extractReadablePage('https://public-site.example/no-ct', 'No CT', {
    requestFn: async () => ({
      statusCode: 200,
      headers: {},
      body: Readable.from([
        '<!DOCTYPE html><html><body><article><h1>Artigo</h1><p>Conteúdo textual longo suficiente para passar no filtro mínimo de legibilidade do Readability sem content-type explícito.</p></article></body></html>'
      ])
    })
  });
  assert.equal(noContentType, null, 'Resposta sem Content-Type explícito deve ser rejeitada');

  // Rejeição de resposta binária (application/octet-stream)
  const binaryContentType = await extractReadablePage('https://public-site.example/bin', 'Bin', {
    requestFn: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: { dump: async () => {} }
    })
  });
  assert.equal(binaryContentType, null);

  // buildSnippetFallbackSource também recusa URLs privadas/internas
  const longDesc = 'Descrição sintética com mais de noventa caracteres tentando vazar um alvo interno pela rota de fallback de snippet SERP.';
  assert.equal(buildSnippetFallbackSource({ url: 'http://169.254.169.254/latest/meta-data/', title: 'IMDS', description: longDesc }), null);
  assert.equal(buildSnippetFallbackSource({ url: 'http://127.0.0.1:3000/', title: 'Local', description: longDesc }), null);
  assert.equal(buildSnippetFallbackSource({ url: 'http://localhost:8888/', title: 'Localhost', description: longDesc }), null);
  assert.equal(buildSnippetFallbackSource({ url: 'javascript:alert(1)', title: 'XSS', description: longDesc }), null);
});

test('APP-01.4: createSafeHttpDispatcher bloqueia hosts internos e IPs privados no connect', async () => {
  const dispatcher = createSafeHttpDispatcher({
    timeout: 1500,
    lookupFn: async (host) => {
      if (host === 'evil-rebind.example') {
        return [{ address: '127.0.0.1', family: 4 }];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    }
  });

  try {
    await assert.rejects(
      () =>
        dispatcher.request({
          origin: 'http://127.0.0.1:1',
          path: '/',
          method: 'GET'
        }),
      (err) => err && err.code === 'ERR_SSRF_BLOCKED'
    );

    await assert.rejects(
      () =>
        dispatcher.request({
          origin: 'http://evil-rebind.example',
          path: '/',
          method: 'GET'
        }),
      (err) => err && err.code === 'ERR_SSRF_BLOCKED'
    );
  } finally {
    await dispatcher.close();
  }
});

// ============================================================================
// APP-02: DNS Rebinding + CSRF + Fail-Open Loopback Guard
// ============================================================================
test('APP-02: isLoopbackAddress fail-closed, anti-DNS Rebinding (Host) e anti-CSRF (Origin / Sec-Fetch-Site)', async () => {
  // Fail-closed em strings vazias, nulas ou IPs externos
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress('   '), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress('192.168.3.50'), false);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress('172.17.0.2', false), false);
  assert.equal(isLoopbackAddress('172.17.0.2', true), true);
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:172.18.0.3', true), true);

  // Unit checks Host/Origin
  assert.equal(isAllowedHostHeader('attacker.tld:3000', 3000), false);
  assert.equal(isAllowedHostHeader('localhost:3000', 3000), true);
  assert.equal(isAllowedHostHeader('127.0.0.1:3000', 3000), true);
  assert.equal(isAllowedHostHeader('[::1]:3000', 3000), true);
  assert.equal(isAllowedHostHeader('localhost:9999', 3000), false);
  assert.equal(isAllowedHostHeader('deepevil.local:3000', 3000, { ALLOWED_HOSTS: 'deepevil.local:3000' }), true);

  assert.equal(
    isAllowedOrigin({ method: 'POST', headers: { origin: 'https://evil.tld' }, socket: { localPort: 3000 } }),
    false
  );
  assert.equal(
    isAllowedOrigin({ method: 'POST', headers: { origin: 'null' }, socket: { localPort: 3000 } }),
    false
  );
  assert.equal(
    isAllowedOrigin({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, socket: { localPort: 3000 } }),
    false
  );
  assert.equal(
    isAllowedOrigin({ method: 'POST', headers: { referer: 'https://evil.tld/pwn' }, socket: { localPort: 3000 } }),
    false
  );
  assert.equal(
    isAllowedOrigin({ method: 'POST', headers: {}, socket: { localPort: 3000 } }),
    true
  );

  // Teste HTTP real contra servidor efêmero Express
  const db = createDatabase(':memory:');
  const app = createApp({
    db,
    qdrant: createNoopQdrant(),
    listModelsFn: async () => [{ name: 'granite4.2-uncensored:latest', parameterSize: '8B' }],
    checkOllamaFn: async () => ({ online: true, version: '0.6.0', latencyMs: 2 })
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // 1. DNS Rebinding: Host: attacker.tld:3000 -> 403
    const rebindRes = await rawHttpRequest({
      port,
      method: 'GET',
      reqPath: '/health',
      headers: { Host: 'attacker.tld:3000' }
    });
    assert.equal(rebindRes.statusCode, 403);

    // 2. Host legítimo localhost:<port> -> 200 + headers defensivos
    const validHostRes = await rawHttpRequest({
      port,
      method: 'GET',
      reqPath: '/health',
      headers: { Host: `localhost:${port}` }
    });
    assert.equal(validHostRes.statusCode, 200);
    assert.equal(validHostRes.headers['x-frame-options'], 'DENY');
    assert.equal(validHostRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(validHostRes.headers['referrer-policy'], 'no-referrer');
    assert.match(String(validHostRes.headers['content-security-policy'] || ''), /default-src 'self'/);
    assert.equal(validHostRes.headers['x-powered-by'], undefined);

    // 3. CSRF: POST /ask com Origin: https://evil.tld -> 403
    const csrfOriginRes = await rawHttpRequest({
      port,
      method: 'POST',
      reqPath: '/ask',
      headers: {
        Host: `localhost:${port}`,
        Origin: 'https://evil.tld',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'question=teste+csrf'
    });
    assert.equal(csrfOriginRes.statusCode, 403);

    // 4. CSRF: POST /ask com Sec-Fetch-Site: cross-site -> 403
    const csrfFetchSiteRes = await rawHttpRequest({
      port,
      method: 'POST',
      reqPath: '/ask',
      headers: {
        Host: `localhost:${port}`,
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'question=teste+cross+site'
    });
    assert.equal(csrfFetchSiteRes.statusCode, 403);

    // 5. Chamada CLI/non-browser sem Origin/Referer com Host válido -> 200
    const cliAskRes = await rawHttpRequest({
      port,
      method: 'POST',
      reqPath: '/ask',
      headers: {
        Host: `localhost:${port}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'question=teste+cli+legitimo'
    });
    assert.equal(cliAskRes.statusCode, 200);
  } finally {
    server.close();
    db.close();
  }
});

// ============================================================================
// APP-03: TLS Estrito (zero rejectUnauthorized: false ou setGlobalDispatcher)
// ============================================================================
test('APP-03: nenhum arquivo em src/ utiliza rejectUnauthorized: false ou setGlobalDispatcher', () => {
  const srcDir = path.join(PROJECT_ROOT, 'src');
  const jsFiles = collectJsFiles(srcDir);
  assert.ok(jsFiles.length >= 8, 'Deve auditar todos os arquivos JS em src/');

  for (const filePath of jsFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const rel = path.relative(PROJECT_ROOT, filePath);
    assert.doesNotMatch(
      content,
      /rejectUnauthorized\s*:\s*false/,
      `TLS inseguro (rejectUnauthorized: false) encontrado em ${rel}`
    );
    assert.doesNotMatch(
      content,
      /\bsetGlobalDispatcher\b/,
      `Mutação global de dispatcher (setGlobalDispatcher) encontrada em ${rel}`
    );
  }
});

// ============================================================================
// APP-04: XSS / HTMLi / Safe URLs + Auditoria Estática de public/app.js
// ============================================================================
test('APP-04: escapeHtml em erro SSE (/stream/:id), safeHttpUrl e zero innerHTML inseguro em public/app.js', async () => {
  // 4.1 safeHttpUrl
  assert.equal(safeHttpUrl('javascript:alert(1)'), '#');
  assert.equal(safeHttpUrl('JAVASCRIPT:alert(1)'), '#');
  assert.equal(safeHttpUrl('  javascript:void(0)  '), '#');
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), '#');
  assert.equal(safeHttpUrl('vbscript:msgbox(1)'), '#');
  assert.equal(safeHttpUrl('file:///etc/passwd'), '#');
  assert.equal(safeHttpUrl('https://ok.example/path?a=1'), 'https://ok.example/path?a=1');
  assert.equal(safeHttpUrl('http://ok.example/'), 'http://ok.example/');

  // 4.2 escapeHtml & Markdown XSS
  const xssPayload = '<img hx-trigger="load" hx-delete="/conversations/1">';
  const escaped = escapeHtml(xssPayload);
  assert.equal(escaped, '&lt;img hx-trigger=&quot;load&quot; hx-delete=&quot;/conversations/1&quot;&gt;');

  const mdHtml = renderAnswerMarkdownWithFootnotes(
    'Texto seguro <script>alert(1)</script> e [link malicioso](javascript:alert(1)) e ![img](javascript:alert(2)).',
    99,
    []
  );
  assert.doesNotMatch(mdHtml, /<script>/i);
  assert.doesNotMatch(mdHtml, /href="javascript:/i);
  assert.match(mdHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  // 4.3 Erro SSE no /stream/:id escapando HTML/htmx injection
  const db = createDatabase(':memory:');
  const app = createApp({
    db,
    qdrant: createNoopQdrant(),
    searchFn: async () => ({
      results: [{ url: 'https://example.org/doc', title: 'Doc' }],
      error: null
    }),
    extractFn: async () => ({
      sources: [
        {
          citationIndex: 1,
          url: 'https://example.org/doc',
          title: 'Doc',
          domain: 'example.org',
          excerpt: 'Texto extraído legível para o teste de erro SSE.',
          wordCount: 8,
          charCount: 48
        }
      ],
      attemptedCount: 1,
      succeededCount: 1
    }),
    streamAnswerFn: async () => {
      throw new Error(xssPayload);
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const askRes = await fetch(`http://127.0.0.1:${port}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true' },
      body: new URLSearchParams({ question: 'teste xss sse' })
    });
    assert.equal(askRes.status, 200);

    const sseRes = await fetch(`http://127.0.0.1:${port}/stream/1`);
    assert.equal(sseRes.status, 200);
    const sseBody = await sseRes.text();

    assert.doesNotMatch(sseBody, /<img\s+hx-trigger=/i, 'Payload HTML/htmx cru JAMAIS pode ser injetado no SSE');
    assert.match(sseBody, /&lt;img hx-trigger=&quot;load&quot; hx-delete=&quot;\/conversations\/1&quot;&gt;/);
  } finally {
    server.close();
    db.close();
  }

  // 4.4 Auditoria estática de public/app.js: zero innerHTML com template literal/concatenação, eval, document.write
  const appJsPath = path.join(PROJECT_ROOT, 'public', 'app.js');
  const appJs = fs.readFileSync(appJsPath, 'utf-8');
  assert.doesNotMatch(appJs, /\.innerHTML\s*=\s*`/, 'public/app.js não deve interpolar template strings em innerHTML');
  assert.doesNotMatch(appJs, /\.innerHTML\s*\+=/, 'public/app.js não deve concatenar em innerHTML');
  assert.doesNotMatch(appJs, /\bdocument\.write\s*\(/, 'public/app.js não deve usar document.write');
  assert.doesNotMatch(appJs, /\beval\s*\(/, 'public/app.js não deve usar eval');
  assert.doesNotMatch(appJs, /\bnew\s+Function\s*\(/, 'public/app.js não deve usar new Function');
  assert.doesNotMatch(appJs, /\.insertAdjacentHTML\s*\(/, 'public/app.js não deve usar insertAdjacentHTML');

  // Todas as atribuições .innerHTML = existentes devem ser estritamente fragmentos já sanitizados do servidor
  const innerHtmlWrites = [...appJs.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  const allowedExpressions = new Set(['e.data', 'data.html', 'cache.get(String(turnId))']);
  for (const expr of innerHtmlWrites) {
    assert.ok(
      allowedExpressions.has(expr),
      `Atribuição innerHTML inesperada/insegura em public/app.js: .innerHTML = ${expr}`
    );
  }
});

// ============================================================================
// APP-05: SSE Multi-line Preservation & Bare \r Injection Defense
// ============================================================================
test('APP-05: sanitizeSseDataLines preserva quebras de linha em <pre><code> e neutraliza bare \\r', () => {
  const codeHtml = '<pre class="code-block"><code>const a = 1;\nconst b = 2;\nreturn a + b;</code></pre>';
  const encodedCode = sanitizeSseDataLines(codeHtml);
  const codeLines = encodedCode.split('\n');
  assert.equal(codeLines.length, 3);
  assert.equal(codeLines[0], 'data: <pre class="code-block"><code>const a = 1;');
  assert.equal(codeLines[1], 'data: const b = 2;');
  assert.equal(codeLines[2], 'data: return a + b;</code></pre>');

  // Reconstrução segundo spec WHATWG EventSource (join('\n') após remover prefixo "data: ")
  const reconstructed = codeLines.map((l) => l.replace(/^data: /, '')).join('\n');
  assert.equal(reconstructed, codeHtml);

  // Neutralização de bare \r tentando injetar novo frame SSE (`event: hacked`)
  const crInjection = 'texto normal\revent: hacked\rdata: <script>alert(1)</script>\r\nfim';
  const encodedInjection = sanitizeSseDataLines(crInjection);
  assert.equal(encodedInjection.includes('\r'), false, 'Nenhum caractere \\r cru pode sobreviver no frame SSE');
  const injLines = encodedInjection.split('\n');
  assert.equal(injLines.length, 4);
  for (const line of injLines) {
    assert.ok(line.startsWith('data: '), `Toda linha SSE deve ser prefixada com "data: " (recebido: ${line})`);
    assert.doesNotMatch(line, /^event:/i, 'Bare \\r não pode abrir nova diretiva event:');
  }
});

// ============================================================================
// APP-06: Input Validation (targetLang, question length, limit NaN, prototype)
// ============================================================================
test('APP-06: validação estrita de entrada em /translate, /translate/stream, /ask e /api/qdrant/search', async () => {
  // Unit checks validateTargetLang & parsePositiveInt
  assert.equal(validateTargetLang('__proto__', SUPPORTED_TRANSLATION_LANGUAGES), null);
  assert.equal(validateTargetLang('constructor', SUPPORTED_TRANSLATION_LANGUAGES), null);
  assert.equal(validateTargetLang('toString', SUPPORTED_TRANSLATION_LANGUAGES), null);
  assert.equal(validateTargetLang('klingon', SUPPORTED_TRANSLATION_LANGUAGES), null);
  assert.equal(validateTargetLang('pt-br', SUPPORTED_TRANSLATION_LANGUAGES), 'pt-BR');
  assert.equal(validateTargetLang('EN', SUPPORTED_TRANSLATION_LANGUAGES), 'en');
  assert.equal(validateTargetLang('es', new Set(['en', 'es'])), 'es');
  assert.equal(validateTargetLang('FR', ['pt-BR', 'fr']), 'fr');

  assert.equal(parsePositiveInt('abc', 8, 1, 30), 8);
  assert.equal(parsePositiveInt('-5', 8, 1, 30), 8);
  assert.equal(parsePositiveInt('0', 8, 1, 30), 8);
  assert.equal(parsePositiveInt('999', 8, 1, 30), 30);
  assert.equal(parsePositiveInt('12', 8, 1, 30), 12);
  assert.equal(parsePositiveInt('3.14', 8, 1, 30), 8);

  const db = createDatabase(':memory:');
  const conv = db.createConversation('Pergunta válida');
  const turn = db.createTurn({
    conversationId: conv.id,
    question: 'Pergunta válida',
    provider: 'ollama',
    model: 'granite4.2-uncensored:latest'
  });
  db.completeTurn(turn.id, {
    answerMarkdown: 'Resposta concluída.',
    provider: 'ollama',
    model: 'granite4.2-uncensored:latest'
  });

  const capturedSearchLimits = [];
  const app = createApp({
    db,
    qdrant: createNoopQdrant({
      searchKnowledge: async (_q, limit) => {
        capturedSearchLimits.push(limit);
        return [];
      }
    })
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. POST /turns/:id/translate com targetLang inválido e prototype key -> 400
    for (const badLang of ['invalid-lang', '__proto__', 'constructor', '<script>']) {
      const res = await fetch(`${baseUrl}/turns/${turn.id}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLang: badLang })
      });
      assert.equal(res.status, 400, `POST /translate deveria retornar 400 para targetLang=${badLang}`);
    }

    // 2. GET /turns/:id/translate/stream com lang inválido -> 400
    for (const badLang of ['invalid-lang', '__proto__']) {
      const res = await fetch(`${baseUrl}/turns/${turn.id}/translate/stream?lang=${encodeURIComponent(badLang)}`);
      assert.equal(res.status, 400, `GET /translate/stream deveria retornar 400 para lang=${badLang}`);
    }

    // 3. GET /turns/:id/export.md com lang inválido -> 400
    const badExport = await fetch(`${baseUrl}/turns/${turn.id}/export.md?lang=invalid-lang`);
    assert.equal(badExport.status, 400);

    // 4. POST /ask com question > 2000 chars -> 400
    const tooLongRes = await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ question: 'A'.repeat(2001) })
    });
    assert.equal(tooLongRes.status, 400);

    // POST /ask vazio -> 400
    const emptyRes = await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ question: '   ' })
    });
    assert.equal(emptyRes.status, 400);

    // 5. GET /api/qdrant/search?limit=abc não pode passar NaN
    const qdrantNanRes = await fetch(`${baseUrl}/api/qdrant/search?q=sqlite&limit=abc`);
    assert.equal(qdrantNanRes.status, 200);
    const qdrantClampRes = await fetch(`${baseUrl}/api/qdrant/search?q=sqlite&limit=9999`);
    assert.equal(qdrantClampRes.status, 200);

    assert.equal(capturedSearchLimits.length, 2);
    assert.equal(Number.isNaN(capturedSearchLimits[0]), false);
    assert.equal(capturedSearchLimits[0], 8);
    assert.equal(capturedSearchLimits[1], 30);

    // 6. IDs inválidos -> 400
    assert.equal((await fetch(`${baseUrl}/conversations/not-a-number`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${baseUrl}/turns/not-a-number/stop`, { method: 'POST' })).status, 400);
    assert.equal((await fetch(`${baseUrl}/turns/not-a-number/rewrite`, { method: 'POST' })).status, 400);

    // 7. JSON malformado -> 400 sem stack trace; payload > 64KB -> 413
    const badJsonRes = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{"query": broken'
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonBody = await badJsonRes.json();
    assert.equal(badJsonBody.ok, false);
    assert.doesNotMatch(JSON.stringify(badJsonBody), /SyntaxError|at\s+\w+/);

    const hugePayloadRes = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: 'A'.repeat(70 * 1024) })
    });
    assert.equal(hugePayloadRes.status, 413);

    // 8. Navegação (/new, /c/:id, /stream/999, /stream/:completedId) + DELETE conversa ativa com HX-Push-Url
    const newHxRes = await fetch(`${baseUrl}/new`, { headers: { 'HX-Request': 'true' } });
    assert.equal(newHxRes.status, 200);
    assert.match(await newHxRes.text(), /id="stage-shell"/);

    const convRes = await fetch(`${baseUrl}/c/${conv.id}`, { headers: { 'HX-Request': 'true' } });
    assert.equal(convRes.status, 200);
    assert.match(await convRes.text(), /Pergunta válida/);

    const missingConvRes = await fetch(`${baseUrl}/conversations/99999`, { headers: { 'HX-Request': 'true' } });
    assert.equal(missingConvRes.status, 404);

    const missingStreamRes = await fetch(`${baseUrl}/stream/99999`);
    assert.equal(missingStreamRes.status, 200);
    assert.match(await missingStreamRes.text(), /Turno não encontrado/);

    const completedStreamRes = await fetch(`${baseUrl}/stream/${turn.id}`);
    assert.equal(completedStreamRes.status, 200);
    const completedSse = await completedStreamRes.text();
    assert.match(completedSse, /Resposta concluída/);
    assert.match(completedSse, /event: done/);

    const delRes = await fetch(`${baseUrl}/conversations/${conv.id}?activeConversationId=${conv.id}`, {
      method: 'DELETE',
      headers: { 'HX-Request': 'true' }
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.headers.get('hx-push-url'), '/');
    assert.match(await delRes.text(), /hx-swap-oob="innerHTML"/);

    // Shutdown helper abortActiveStreams não lança erro
    app.locals.abortActiveStreams();
  } finally {
    server.close();
    db.close();
  }
});

// ============================================================================
// INFRA Check: Dockerfile, .dockerignore, searxng/settings.yml, docker-compose
// ============================================================================
test('INFRA: Dockerfile hardened (multi-stage, USER node, npm ci), .dockerignore presente e zero secret hardcoded no SearXNG', () => {
  const dockerfilePath = path.join(PROJECT_ROOT, 'Dockerfile');
  const dockerignorePath = path.join(PROJECT_ROOT, '.dockerignore');
  const searxSettingsPath = path.join(PROJECT_ROOT, 'searxng', 'settings.yml');
  const composePath = path.join(PROJECT_ROOT, 'docker-compose.yml');

  const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
  const fromMatches = dockerfile.match(/^FROM\s+.+/gm) || [];
  assert.ok(fromMatches.length >= 2, 'Dockerfile deve ser multi-stage (>= 2 instruções FROM)');
  assert.doesNotMatch(dockerfile, /^FROM\s+\S+:latest\b/m, 'Dockerfile não deve usar tag :latest');
  assert.match(dockerfile, /^\s*USER\s+node\b/m, 'Dockerfile deve executar como usuário não-root (USER node)');
  assert.match(dockerfile, /\bnpm\s+ci\b/, 'Dockerfile deve usar npm ci reproduzível');
  assert.match(dockerfile, /^\s*HEALTHCHECK\b/m, 'Dockerfile deve definir HEALTHCHECK');

  assert.equal(fs.existsSync(dockerignorePath), true, '.dockerignore deve existir');
  const dockerignore = fs.readFileSync(dockerignorePath, 'utf-8');
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^data\/?$/m);

  const searxSettings = fs.readFileSync(searxSettingsPath, 'utf-8');
  assert.doesNotMatch(
    searxSettings,
    /perplexity-local-homelab-secret-key-searxng/,
    'searxng/settings.yml NÃO pode conter secret_key hardcoded'
  );
  assert.match(searxSettings, /secret_key:\s*["']\$\{SEARXNG_SECRET\}["']/);

  const compose = fs.readFileSync(composePath, 'utf-8');
  assert.doesNotMatch(compose, /image:\s*\S+:latest\b/, 'docker-compose.yml não deve usar imagem :latest');
  assert.match(compose, /cap_drop:[\s\S]*?- ALL/);
  assert.match(compose, /no-new-privileges:true/);
});

// ============================================================================
// SDK-01: Contrato Oficial POST /api/search (Rust deepevil-sdk <-> Node.js)
// ============================================================================
test('SDK-01: POST /api/search valida payload, mapeia focus sec_ops -> secops e respeita schema canônico', async () => {
  const db = createDatabase(':memory:');
  let capturedSearchCall = null;

  const app = createApp({
    db,
    qdrant: createNoopQdrant(),
    searchFn: async (query, opts) => {
      // Aguarda um tick para garantir que o fim do body POST (req.close no Node 22) NÃO abortou o signal!
      await new Promise((r) => setTimeout(r, 20));
      capturedSearchCall = { query, opts, signalAborted: Boolean(opts?.signal?.aborted) };
      return {
        provider: 'searxng',
        results: [
          {
            url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-34351',
            title: 'NVD - CVE-2024-34351',
            description: 'Next.js Server-Side Request Forgery in Server Actions.',
            countryPole: 'US'
          },
          {
            url: 'https://github.com/vercel/next.js/security/advisories',
            title: 'Next.js Security Advisories',
            snippet: 'Mitigation guidance for CVE-2024-34351.'
          }
        ],
        error: null
      };
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Consulta válida com alias sec_ops -> secops
    const res = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'CVE-2024-34351 nextjs',
        focus: 'sec_ops',
        limit: 5
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.query, 'CVE-2024-34351 nextjs');
    assert.match(data.effectiveQuery, /CVE-2024-34351 nextjs/);
    assert.match(data.effectiveQuery, /CVE|exploit|advisory|vulnerability/i);
    assert.equal(data.focus, 'secops');
    assert.equal(capturedSearchCall.opts.focusMode, 'secops');
    assert.equal(capturedSearchCall.opts.count, 5);
    assert.equal(capturedSearchCall.signalAborted, false, 'POST /api/search não pode abortar signal após fim do body no Node 22');
    assert.ok(Array.isArray(data.results));
    assert.ok(Array.isArray(data.sources));
    assert.equal(data.results.length, 2);
    assert.equal(data.sources.length, 2);
    assert.equal(data.results[0].url, 'https://nvd.nist.gov/vuln/detail/CVE-2024-34351');
    assert.equal(data.results[0].domain, 'nvd.nist.gov');
    assert.match(data.results[0].snippet, /Server-Side Request Forgery/);
    assert.equal(data.results[0].countryPole, 'US');

    // 2. Query vazia -> 400
    const emptyRes = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' })
    });
    assert.equal(emptyRes.status, 400);

    // 3. Query acima de 2000 chars -> 400
    const longRes = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(2001) })
    });
    assert.equal(longRes.status, 400);
  } finally {
    server.close();
    db.close();
  }
});

// ============================================================================
// BTM /health: Healthcheck Não-Anêmico (SQLite + Ollama + Qdrant)
// ============================================================================
test('BTM /health executa sondas reais de SQLite, Ollama e Qdrant (200 ok / 200 degraded / 503 sqlite down)', async () => {
  // Cenário 1: todas as dependências saudáveis -> 200 + status: "ok"
  const dbOk = createDatabase(':memory:');
  const appOk = createApp({
    db: dbOk,
    qdrant: createNoopQdrant({
      checkHealth: async () => ({ online: true, collection: 'deepevil_conversations_v2', vectorSize: 1024 })
    }),
    checkOllamaFn: async () => ({ online: true, version: '0.6.5', latencyMs: 3 })
  });
  const srvOk = http.createServer(appOk);
  await new Promise((resolve) => srvOk.listen(0, '127.0.0.1', resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${srvOk.address().port}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, 'ok');
    assert.equal(json.sqlite.online, true);
    assert.equal(json.ollama.online, true);
    assert.equal(json.qdrant.online, true);
    assert.equal(json.telemetry, 'none');
  } finally {
    srvOk.close();
    dbOk.close();
  }

  // Cenário 2: SQLite online, mas Ollama offline -> 200 + status: "degraded"
  const dbDeg = createDatabase(':memory:');
  const appDeg = createApp({
    db: dbDeg,
    qdrant: createNoopQdrant({
      checkHealth: async () => ({ online: false })
    }),
    checkOllamaFn: async () => ({ online: false, latencyMs: 1001 })
  });
  const srvDeg = http.createServer(appDeg);
  await new Promise((resolve) => srvDeg.listen(0, '127.0.0.1', resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${srvDeg.address().port}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, 'degraded');
    assert.equal(json.sqlite.online, true);
    assert.equal(json.ollama.online, false);
    assert.equal(json.qdrant.online, false);
  } finally {
    srvDeg.close();
    dbDeg.close();
  }

  // Cenário 3: SQLite indisponível -> 503 Service Unavailable
  const brokenDb = {
    raw: {
      prepare: () => {
        throw new Error('SQLITE_CORRUPT');
      }
    }
  };
  const appDown = createApp({
    db: brokenDb,
    qdrant: createNoopQdrant(),
    checkOllamaFn: async () => ({ online: true, version: '0.6.5', latencyMs: 1 })
  });
  const srvDown = http.createServer(appDown);
  await new Promise((resolve) => srvDown.listen(0, '127.0.0.1', resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${srvDown.address().port}/health`);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.status, 'degraded');
    assert.equal(json.sqlite.online, false);
  } finally {
    srvDown.close();
  }
});
