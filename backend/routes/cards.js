const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// Helper: verify card ownership through column -> board -> user
function getCardWithOwnership(db, cardId, userId) {
  return db.prepare(`
    SELECT c.*, col.board_id, b.user_id
    FROM cards c
    JOIN columns col ON c.column_id = col.id
    JOIN boards b ON col.board_id = b.id
    WHERE c.id = ?
  `).get(cardId);
}

function verifyColumnOwnership(db, columnId, userId) {
  return db.prepare(`
    SELECT col.*, b.user_id
    FROM columns col
    JOIN boards b ON col.board_id = b.id
    WHERE col.id = ?
  `).get(columnId, userId);
}

// Canonical position rule for cards, identical in spirit to the column rule:
// dense 0-based index inside a column. Return the number of cards in a column
// excluding optionally one card (used when the moved card still occupies a slot).
function cardCount(db, columnId, excludeCardId = null) {
  const row = excludeCardId
    ? db
        .prepare('SELECT COUNT(*) AS cnt FROM cards WHERE column_id = ? AND id != ?')
        .get(columnId, excludeCardId)
    : db.prepare('SELECT COUNT(*) AS cnt FROM cards WHERE column_id = ?').get(columnId);
  return row.cnt;
}

// GET /api/columns/:columnId/cards - Get cards in column
router.get('/columns/:columnId/cards', (req, res) => {
  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    const cards = db.prepare(`
      SELECT * FROM cards
      WHERE column_id = ?
      ORDER BY position ASC, id ASC
    `).all(req.params.columnId);

    db.close();
    res.json(cards);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

// POST /api/columns/:columnId/cards - Add card
router.post('/columns/:columnId/cards', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Card title is required' });
  }

  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    // Append at the canonical end position: current card count.
    const newPosition = cardCount(db, req.params.columnId);

    const result = db.prepare(`
      INSERT INTO cards (column_id, title, description, priority, due_date, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.columnId,
      title.trim(),
      description || '',
      priority || 'medium',
      due_date || null,
      newPosition
    );

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid);
    db.close();
    res.status(201).json(card);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PUT /api/cards/:id - Update card
router.put('/cards/:id', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  const db = getDb();

  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    const updates = [];
    const params = [];

    if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
    if (due_date !== undefined) { updates.push('due_date = ?'); params.push(due_date || null); }

    updates.push("updated_at = datetime('now')");

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to update card' });
  }
});

// DELETE /api/cards/:id - Delete card
router.delete('/cards/:id', (req, res) => {
  const db = getDb();
  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    const applyDelete = db.transaction(() => {
      db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
      // Renumber remaining cards in the column atomically.
      db.prepare(`
        UPDATE cards SET position = position - 1
        WHERE column_id = ? AND position > ?
      `).run(card.column_id, card.position);
    });
    applyDelete();

    db.close();
    res.json({ message: 'Card deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// PUT /api/cards/:id/move - Move card to another position/column.
// One canonical entry point for both cross-column drag and same-column
// reorder: positions are dense 0-based indexes, clamped into the range of
// the destination column after the moved card is conceptually removed.
router.put('/cards/:id/move', (req, res) => {
  const { columnId, position } = req.body;
  if (!columnId) {
    return res.status(400).json({ error: 'Target column ID is required' });
  }
  if (position !== undefined && !Number.isInteger(position)) {
    return res.status(400).json({ error: 'Position must be an integer' });
  }

  const db = getDb();
  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column belongs to same board and user
    const targetCol = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ? AND col.board_id = ?
    `).get(columnId, card.board_id);

    if (!targetCol || targetCol.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Target column not found in this board' });
    }

    const oldColumnId = card.column_id;
    const oldPosition = card.position;

    const applyMove = db.transaction(() => {
      // Valid drop slots are 0..countOfOtherCardsInTarget
      const otherCards = cardCount(db, columnId, req.params.id);
      const requested = position === undefined ? otherCards : position;
      const newPosition = Math.max(0, Math.min(requested, otherCards));

      if (oldColumnId === columnId) {
        if (oldPosition === newPosition) return;
        if (newPosition > oldPosition) {
          db.prepare(`
            UPDATE cards SET position = position - 1
            WHERE column_id = ? AND id != ? AND position > ? AND position <= ?
          `).run(columnId, req.params.id, oldPosition, newPosition);
        } else {
          db.prepare(`
            UPDATE cards SET position = position + 1
            WHERE column_id = ? AND id != ? AND position >= ? AND position < ?
          `).run(columnId, req.params.id, newPosition, oldPosition);
        }
      } else {
        // Remove from old column
        db.prepare(`
          UPDATE cards SET position = position - 1
          WHERE column_id = ? AND position > ?
        `).run(oldColumnId, oldPosition);
        // Make room in target column
        db.prepare(`
          UPDATE cards SET position = position + 1
          WHERE column_id = ? AND position >= ?
        `).run(columnId, newPosition);
      }

      db.prepare(`
        UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(columnId, newPosition, req.params.id);
    });
    applyMove();

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move card' });
  }
});

module.exports = router;
