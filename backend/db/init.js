const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'taskboard.db');

function getDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// Canonical position rule: position is the dense 0-based index of a column
// within its board, and of a card within its column, defined solely by the
// current ORDER BY position, id ranking. Every entry point (drag, delete,
// create, move) converges to this rule; this migration also repairs any gaps
// or duplicate positions left by older data.
function normalizePositions(db) {
  const renumber = db.transaction(() => {
    const boards = db.prepare('SELECT id FROM boards ORDER BY id').all();
    const updateColumn = db.prepare('UPDATE columns SET position = ? WHERE id = ?');
    for (const board of boards) {
      const cols = db
        .prepare('SELECT id FROM columns WHERE board_id = ? ORDER BY position ASC, id ASC')
        .all(board.id);
      cols.forEach((col, i) => updateColumn.run(i, col.id));
    }

    const columns = db.prepare('SELECT id FROM columns ORDER BY id').all();
    const updateCard = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
    for (const col of columns) {
      const cards = db
        .prepare('SELECT id FROM cards WHERE column_id = ? ORDER BY position ASC, id ASC')
        .all(col.id);
      cards.forEach((card, i) => updateCard.run(i, card.id));
    }
  });
  renumber();
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      column_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      due_date TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
    );
  `);

  normalizePositions(db);

  return db;
}

module.exports = { getDb, initDb, normalizePositions };
