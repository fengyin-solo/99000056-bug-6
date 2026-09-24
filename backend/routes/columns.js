const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// Helper: verify that the board belongs to the user
function verifyBoardOwnership(db, boardId, userId) {
  return db.prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?').get(boardId, userId);
}

// Canonical position rule shared by every entry point:
// positions are dense 0-based indexes within a board. Clamp any requested
// position into the valid [0, count - 1] range so drag/rename/create/delete
// callers can never create gaps or duplicate positions.
function clampColumnPosition(db, boardId, columnId, requested) {
  const { cnt } = db
    .prepare('SELECT COUNT(*) AS cnt FROM columns WHERE board_id = ?')
    .get(boardId);
  const maxPos = cnt - 1;
  const pos = Number.isInteger(requested) ? requested : maxPos;
  return Math.max(0, Math.min(pos, maxPos));
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

// POST /api/boards/:boardId/columns - Add column
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

    // A new column is always appended: its canonical position is the
    // current column count, regardless of any gaps in stored positions.
    const { cnt } = db
      .prepare('SELECT COUNT(*) AS cnt FROM columns WHERE board_id = ?')
      .get(req.params.boardId);
    const newPosition = cnt;

    const result = db.prepare('INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)').run(
      req.params.boardId,
      name.trim(),
      newPosition
    );

    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(result.lastInsertRowid);
    db.close();
    res.status(201).json(column);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create column' });
  }
});

// PUT /api/columns/:id - Update column (rename, reorder)
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

    if (name !== undefined && (!name || !name.trim())) {
      db.close();
      return res.status(400).json({ error: 'Column name is required' });
    }

    if (position !== undefined && !Number.isInteger(position)) {
      db.close();
      return res.status(400).json({ error: 'Position must be an integer' });
    }

    const applyUpdate = db.transaction(() => {
      // Reorder must happen together with the shift so readers can never
      // observe duplicate positions or gaps between statements.
      if (position !== undefined) {
        const newPos = clampColumnPosition(db, column.board_id, column.id, position);
        const oldPos = column.position;

        if (oldPos !== newPos) {
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
          db.prepare('UPDATE columns SET position = ? WHERE id = ?').run(newPos, column.id);
        }
      }

      if (name !== undefined) {
        db.prepare('UPDATE columns SET name = ? WHERE id = ?').run(name.trim(), column.id);
      }
    });

    applyUpdate();

    const updated = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to update column' });
  }
});

// DELETE /api/columns/:id - Delete column
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

    const applyDelete = db.transaction(() => {
      // Cascade handles the cards, but renumber in the same transaction so
      // remaining columns keep dense canonical positions atomically.
      db.prepare('DELETE FROM cards WHERE column_id = ?').run(req.params.id);
      db.prepare('DELETE FROM columns WHERE id = ?').run(req.params.id);
      db.prepare(`
        UPDATE columns SET position = position - 1
        WHERE board_id = ? AND position > ?
      `).run(column.board_id, column.position);
    });
    applyDelete();

    db.close();
    res.json({ message: 'Column deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete column' });
  }
});

module.exports = router;
