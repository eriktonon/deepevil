'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

/**
 * Inicializa e retorna a camada de persistência SQLite via better-sqlite3.
 * Todas as conversas são identificadas na barra lateral pela primeira pergunta feita.
 */
function createDatabase(customDbPath) {
  const dbPath = customDbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'perplexity.sqlite');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      search_query TEXT NOT NULL DEFAULT '',
      answer_markdown TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      attempted_urls_count INTEGER NOT NULL DEFAULT 0,
      extracted_sources_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id INTEGER NOT NULL,
      citation_index INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      site_name TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE,
      UNIQUE(turn_id, citation_index)
    );

    CREATE INDEX IF NOT EXISTS idx_turns_conversation_id ON turns(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_sources_turn_id ON sources(turn_id);
  `);

  const stmts = {
    insertConversation: db.prepare(`
      INSERT INTO conversations (title, created_at, updated_at)
      VALUES (@title, datetime('now'), datetime('now'))
    `),
    touchConversation: db.prepare(`
      UPDATE conversations
      SET updated_at = datetime('now')
      WHERE id = @id
    `),
    getConversation: db.prepare(`
      SELECT id, title, created_at, updated_at
      FROM conversations
      WHERE id = ?
    `),
    listConversations: db.prepare(`
      SELECT
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        COUNT(t.id) AS turn_count
      FROM conversations c
      LEFT JOIN turns t ON t.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id DESC
    `),
    deleteConversation: db.prepare(`
      DELETE FROM conversations WHERE id = ?
    `),
    insertTurn: db.prepare(`
      INSERT INTO turns (
        conversation_id, question, search_query, status, provider, model
      ) VALUES (
        @conversationId, @question, @searchQuery, 'pending', @provider, @model
      )
    `),
    getTurn: db.prepare(`
      SELECT * FROM turns WHERE id = ?
    `),
    listTurnsByConversation: db.prepare(`
      SELECT * FROM turns
      WHERE conversation_id = ?
      ORDER BY id ASC
    `),
    updateTurnStatus: db.prepare(`
      UPDATE turns
      SET status = @status,
          search_query = COALESCE(@searchQuery, search_query),
          attempted_urls_count = COALESCE(@attemptedUrlsCount, attempted_urls_count),
          extracted_sources_count = COALESCE(@extractedSourcesCount, extracted_sources_count)
      WHERE id = @id
    `),
    updateTurnPartialAnswer: db.prepare(`
      UPDATE turns
      SET answer_markdown = @answerMarkdown,
          status = 'streaming'
      WHERE id = @id
    `),
    completeTurn: db.prepare(`
      UPDATE turns
      SET answer_markdown = @answerMarkdown,
          status = 'completed',
          provider = @provider,
          model = @model,
          attempted_urls_count = @attemptedUrlsCount,
          extracted_sources_count = @extractedSourcesCount,
          duration_ms = @durationMs,
          error_message = NULL
      WHERE id = @id
    `),
    failTurn: db.prepare(`
      UPDATE turns
      SET status = 'error',
          error_message = @errorMessage,
          duration_ms = @durationMs
      WHERE id = @id
    `),
    clearTurnSources: db.prepare(`
      DELETE FROM sources WHERE turn_id = ?
    `),
    insertSource: db.prepare(`
      INSERT INTO sources (
        turn_id, citation_index, url, title, domain, site_name, excerpt, word_count, char_count
      ) VALUES (
        @turnId, @citationIndex, @url, @title, @domain, @siteName, @excerpt, @wordCount, @charCount
      )
    `),
    listSourcesByTurn: db.prepare(`
      SELECT * FROM sources
      WHERE turn_id = ?
      ORDER BY citation_index ASC
    `)
  };

  const saveTurnSourcesTx = db.transaction((turnId, sources) => {
    stmts.clearTurnSources.run(turnId);
    for (const src of sources) {
      stmts.insertSource.run({
        turnId,
        citationIndex: src.citationIndex,
        url: src.url,
        title: src.title,
        domain: src.domain,
        siteName: src.siteName || src.domain,
        excerpt: src.excerpt,
        wordCount: src.wordCount || 0,
        charCount: src.charCount || src.excerpt.length
      });
    }
  });

  return {
    raw: db,

    /**
     * Cria uma nova conversa cujo título é estritamente a primeira pergunta feita.
     */
    createConversation(firstQuestion) {
      const cleanTitle = String(firstQuestion || '').trim() || 'Nova pergunta';
      const info = stmts.insertConversation.run({ title: cleanTitle });
      return stmts.getConversation.get(info.lastInsertRowid);
    },

    getConversation(id) {
      return stmts.getConversation.get(Number(id)) || null;
    },

    listConversations() {
      return stmts.listConversations.all();
    },

    deleteConversation(id) {
      return stmts.deleteConversation.run(Number(id)).changes > 0;
    },

    createTurn({ conversationId, question, searchQuery = '', provider = '', model = '' }) {
      const convId = Number(conversationId);
      const info = stmts.insertTurn.run({
        conversationId: convId,
        question: String(question).trim(),
        searchQuery: String(searchQuery || question).trim(),
        provider,
        model
      });
      stmts.touchConversation.run({ id: convId });
      return stmts.getTurn.get(info.lastInsertRowid);
    },

    getTurn(turnId) {
      const turn = stmts.getTurn.get(Number(turnId));
      if (!turn) return null;
      turn.sources = stmts.listSourcesByTurn.all(turn.id);
      return turn;
    },

    getConversationWithTurns(conversationId) {
      const conv = stmts.getConversation.get(Number(conversationId));
      if (!conv) return null;
      const turns = stmts.listTurnsByConversation.all(conv.id).map((turn) => ({
        ...turn,
        sources: stmts.listSourcesByTurn.all(turn.id)
      }));
      return {
        ...conv,
        turns
      };
    },

    /**
     * Retorna o histórico de turnos já concluídos para compor o contexto de follow-up.
     */
    getPriorCompletedTurns(conversationId, excludeTurnId = null) {
      const turns = stmts.listTurnsByConversation.all(Number(conversationId));
      return turns
        .filter((t) => t.status === 'completed' && t.answer_markdown && t.id !== Number(excludeTurnId))
        .map((t) => ({
          ...t,
          sources: stmts.listSourcesByTurn.all(t.id)
        }));
    },

    saveTurnSources(turnId, sources) {
      saveTurnSourcesTx(Number(turnId), sources);
    },

    updateTurnStatus(turnId, status, extra = {}) {
      stmts.updateTurnStatus.run({
        id: Number(turnId),
        status,
        searchQuery: extra.searchQuery ?? null,
        attemptedUrlsCount: extra.attemptedUrlsCount ?? null,
        extractedSourcesCount: extra.extractedSourcesCount ?? null
      });
    },

    updateTurnPartialAnswer(turnId, answerMarkdown) {
      stmts.updateTurnPartialAnswer.run({
        id: Number(turnId),
        answerMarkdown
      });
    },

    completeTurn(turnId, {
      answerMarkdown,
      provider = '',
      model = '',
      attemptedUrlsCount = 0,
      extractedSourcesCount = 0,
      durationMs = 0
    }) {
      const turn = stmts.getTurn.get(Number(turnId));
      stmts.completeTurn.run({
        id: Number(turnId),
        answerMarkdown,
        provider,
        model,
        attemptedUrlsCount,
        extractedSourcesCount,
        durationMs
      });
      if (turn) {
        stmts.touchConversation.run({ id: turn.conversation_id });
      }
      return this.getTurn(turnId);
    },

    failTurn(turnId, errorMessage, durationMs = 0) {
      stmts.failTurn.run({
        id: Number(turnId),
        errorMessage: String(errorMessage || 'Erro desconhecido'),
        durationMs
      });
      return this.getTurn(turnId);
    },

    close() {
      db.close();
    }
  };
}

module.exports = { createDatabase };
