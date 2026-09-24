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

    // Dense append: new position equals the current card count, so gaps in
    // legacy data can never be inherited.
    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM cards WHERE column_id = ?').get(req.params.columnId);
    const newPosition = countRow.cnt;

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

    const remove = db.transaction(() => {
      db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);

      // Renumber survivors by current visual order so positions stay dense
      // even if a gap/duplicate already existed.
      const survivors = db.prepare(`
        SELECT id FROM cards
        WHERE column_id = ?
        ORDER BY position ASC, id ASC
      `).all(card.column_id);
      const setPos = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
      survivors.forEach((row, index) => setPos.run(index, row.id));
    });
    remove();

    db.close();
    res.json({ message: 'Card deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// PUT /api/cards/:id/move - Move/reorder a card
//
// Same canonical rule as columns: within one column card positions are a
// dense 0..n-1 sequence. The requested index is clamped to the valid range
// and the whole move runs in one transaction, so same-column reordering and
// cross-column moves both leave every column with a dense sequence.
router.put('/cards/:id/move', (req, res) => {
  const { columnId, position } = req.body;
  if (!columnId) {
    return res.status(400).json({ error: 'Target column ID is required' });
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

    const move = db.transaction(() => {
      // Read each affected column in its current visual order, then rebuild
      // dense 0..n-1 positions around the moved card. Renumbering from the
      // ordered id lists is safe even if old positions had gaps/duplicates.
      const listIds = db.prepare(`
        SELECT id FROM cards
        WHERE column_id = ? AND id != ?
        ORDER BY position ASC, id ASC
      `);
      const setPos = db.prepare('UPDATE cards SET position = ? WHERE id = ?');

      const sourceIds = listIds.all(card.column_id, card.id).map(r => r.id);
      const otherIds = card.column_id === columnId
        ? sourceIds
        : listIds.all(columnId, card.id).map(r => r.id);

      // Clamp the requested insertion index against the target column size.
      let insertAt = Number.isInteger(position) ? position : otherIds.length;
      insertAt = Math.max(0, Math.min(insertAt, otherIds.length));

      // Target column: existing cards with the moved card inserted at insertAt.
      const targetIds = otherIds.slice();
      targetIds.splice(insertAt, 0, card.id);
      targetIds.forEach((id, index) => setPos.run(index, id));

      // Source column: only renumber separately when it is a different column.
      if (card.column_id !== columnId) {
        sourceIds.forEach((id, index) => setPos.run(index, id));
      }

      // Attach the card to the target column at its final slot.
      db.prepare(`
        UPDATE cards
        SET column_id = ?, position = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(columnId, insertAt, req.params.id);
    });

    move();

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move card' });
  }
});

module.exports = router;
