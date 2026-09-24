const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Canonical position rule (single source of truth for every entry point):
//
//   Within one board, column positions are ALWAYS a dense sequence 0..n-1.
//   The server is the only authority: reads order by (position ASC, id ASC)
//   and every write keeps the sequence dense inside a single transaction.
//   Drag (reorder), delete and add all go through the helpers below so the
//   result is identical whether the user comes back later or acts again.
// ---------------------------------------------------------------------------

// Helper: verify that the board belongs to the user
function verifyBoardOwnership(db, boardId, userId) {
  return db.prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?').get(boardId, userId);
}

// Reload all columns of a board in the canonical order.
function listColumnsInOrder(db, boardId) {
  return db.prepare(`
    SELECT id, position FROM columns
    WHERE board_id = ?
    ORDER BY position ASC, id ASC
  `).all(boardId);
}

// Rewrite positions as a dense 0..n-1 sequence, preserving current order.
function normalizePositions(db, boardId) {
  const cols = listColumnsInOrder(db, boardId);
  const update = db.prepare('UPDATE columns SET position = ? WHERE id = ?');
  cols.forEach((col, index) => {
    if (col.position !== index) update.run(index, col.id);
  });
  return cols.map((col, index) => ({ id: col.id, position: index }));
}

// GET /api/boards/:boardId/columns - Get columns for a board (with card counts)
router.get('/boards/:boardId/columns', (req, res) => {
  const db = getDb();
  try {
    const board = verifyBoardOwnership(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    const columns = db.prepare(`
      SELECT col.*,
        (SELECT COUNT(*) FROM cards WHERE column_id = col.id) AS card_count
      FROM columns col
      WHERE col.board_id = ?
      ORDER BY col.position ASC, col.id ASC
    `).all(req.params.boardId);

    db.close();
    res.json(columns);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch columns' });
  }
});

// POST /api/boards/:boardId/columns - Add column (always appended at the end)
router.post('/boards/:boardId/columns', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Column name is required' });
  }

  const db = getDb();
  try {
    const board = verifyBoardOwnership(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    const boardId = req.params.boardId;
    const create = db.transaction(() => {
      // Dense append: the new position is exactly the current column count.
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM columns WHERE board_id = ?').get(boardId);
      const result = db.prepare(
        'INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)'
      ).run(boardId, name.trim(), row.cnt);
      return db.prepare(`
        SELECT col.*,
          (SELECT COUNT(*) FROM cards WHERE column_id = col.id) AS card_count
        FROM columns col WHERE col.id = ?
      `).get(result.lastInsertRowid);
    });

    const column = create();
    db.close();
    res.status(201).json(column);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create column' });
  }
});

// PUT /api/boards/:boardId/columns/reorder
// Atomic column reorder. Body: { columnIds: [id, id, ...] } — the COMPLETE
// ordered list of column ids for the board. Drag sends exactly one request,
// so interleaving requests can never create duplicate/gapped positions.
router.put('/boards/:boardId/columns/reorder', (req, res) => {
  const { columnIds } = req.body || {};
  const db = getDb();
  try {
    const board = verifyBoardOwnership(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    if (!Array.isArray(columnIds) || columnIds.some(id => !Number.isInteger(id))) {
      db.close();
      return res.status(400).json({ error: 'columnIds must be an array of integers' });
    }

    const boardId = req.params.boardId;
    const current = listColumnsInOrder(db, boardId);
    const currentIds = current.map(c => c.id);

    // The submitted order must describe exactly this board's columns.
    const sameSet = currentIds.length === columnIds.length &&
      currentIds.every(id => columnIds.includes(id));
    if (!sameSet) {
      db.close();
      return res.status(409).json({ error: 'Column set is out of date, please refresh' });
    }

    const apply = db.transaction(() => {
      const update = db.prepare('UPDATE columns SET position = ? WHERE id = ? AND board_id = ?');
      columnIds.forEach((id, index) => update.run(index, id, boardId));
      return listColumnsInOrder(db, boardId);
    });
    apply();

    const columns = db.prepare(`
      SELECT col.*,
        (SELECT COUNT(*) FROM cards WHERE column_id = col.id) AS card_count
      FROM columns col
      WHERE col.board_id = ?
      ORDER BY col.position ASC, col.id ASC
    `).all(boardId);

    db.close();
    res.json(columns);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to reorder columns' });
  }
});

// PUT /api/columns/:id - Update column name (and, if needed, a single move)
router.put('/columns/:id', (req, res) => {
  const { name, position } = req.body;
  const db = getDb();

  try {
    const column = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ?
    `).get(req.params.id);

    if (!column || column.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    const update = db.transaction(() => {
      if (typeof name === 'string' && name.trim()) {
        db.prepare('UPDATE columns SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
      }

      if (Number.isInteger(position)) {
        // Normalize first so the move is computed against a dense sequence,
        // then clamp the requested index to the valid 0..n-1 range.
        const ordered = normalizePositions(db, column.board_id)
          .map(c => c.id);
        const count = ordered.length;
        const newPos = Math.max(0, Math.min(position, count - 1));
        const oldPos = ordered.indexOf(column.id);

        if (oldPos !== -1 && oldPos !== newPos) {
          if (newPos > oldPos) {
            db.prepare(`
              UPDATE columns SET position = position - 1
              WHERE board_id = ? AND position > ? AND position <= ?
            `).run(column.board_id, oldPos, newPos);
          } else {
            db.prepare(`
              UPDATE columns SET position = position + 1
              WHERE board_id = ? AND position >= ? AND position < ?
            `).run(column.board_id, newPos, oldPos);
          }
          db.prepare('UPDATE columns SET position = ? WHERE id = ?').run(newPos, req.params.id);
        }
      }

      return db.prepare(`
        SELECT col.*,
          (SELECT COUNT(*) FROM cards WHERE column_id = col.id) AS card_count
        FROM columns col WHERE col.id = ?
      `).get(req.params.id);
    });

    const updated = update();
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to update column' });
  }
});

// DELETE /api/columns/:id - Delete column and renumber remaining columns
router.delete('/columns/:id', (req, res) => {
  const db = getDb();
  try {
    const column = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ?
    `).get(req.params.id);

    if (!column || column.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    const remove = db.transaction(() => {
      // Delete cards explicitly (FK cascade would also handle it).
      db.prepare('DELETE FROM cards WHERE column_id = ?').run(req.params.id);
      db.prepare('DELETE FROM columns WHERE id = ?').run(req.params.id);
      // Renumber survivors by their current visual order — works even if the
      // deleted column sat in the middle or positions were previously gapped.
      normalizePositions(db, column.board_id);
    });
    remove();

    db.close();
    res.json({ message: 'Column deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete column' });
  }
});

module.exports = router;
