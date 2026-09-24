import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

// Canonical order shared by every entry point: server-provided `position`
// is a dense 0..n-1 sequence; never derive order from local array state.
function sortColumns(cols) {
  return [...cols].sort((a, b) => a.position - b.position || a.id - b.id)
}

export const useBoardStore = defineStore('board', () => {
  const boards = ref([])
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const loading = ref(false)

  // Board actions
  async function fetchBoards() {
    loading.value = true
    try {
      const res = await boardApi.list()
      boards.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function createBoard(name, description) {
    const res = await boardApi.create(name, description)
    boards.value.unshift(res.data)
    return res.data
  }

  async function deleteBoard(id) {
    await boardApi.delete(id)
    boards.value = boards.value.filter(b => b.id !== id)
  }

  // Column actions
  async function fetchColumns(boardId) {
    loading.value = true
    try {
      const res = await columnApi.list(boardId)
      columns.value = sortColumns(res.data)
      // Keep existing card buckets (e.g. a reorder refresh must not wipe
      // counts), create missing ones and prune stale ones.
      const next = {}
      for (const col of columns.value) {
        next[col.id] = cards.value[col.id] || []
      }
      cards.value = next
    } finally {
      loading.value = false
    }
  }

  async function fetchAllCards(boardId) {
    const cols = columns.value
    const promises = cols.map(col => cardApi.list(col.id))
    const results = await Promise.all(promises)
    const next = {}
    cols.forEach((col, i) => {
      next[col.id] = results[i].data
    })
    cards.value = next
  }

  async function addColumn(boardId, name) {
    const res = await columnApi.create(boardId, name)
    // The server decides the position; adopt its authoritative order.
    columns.value = sortColumns([...columns.value, res.data])
    cards.value[res.data.id] = []
    return res.data
  }

  async function renameColumn(colId, name) {
    const res = await columnApi.update(colId, { name })
    const idx = columns.value.findIndex(c => c.id === colId)
    if (idx !== -1) {
      // Position/card ownership are untouched by a rename; merge fields.
      columns.value[idx] = { ...columns.value[idx], ...res.data }
    }
    return res.data
  }

  async function deleteColumn(colId) {
    await columnApi.delete(colId)
    columns.value = columns.value.filter(c => c.id !== colId)
    // Drop its cards and re-adopt the server's dense positions so the next
    // drag/add/delete works against canonical state.
    const next = {}
    columns.value.forEach((col, index) => {
      col.position = index
      next[col.id] = cards.value[col.id] || []
    })
    cards.value = next
  }

  // Single atomic reorder call for column drag-and-drop.
  async function reorderColumns(boardId, orderedIds) {
    const res = await columnApi.reorder(boardId, orderedIds)
    columns.value = sortColumns(res.data)
    return res.data
  }

  // Card actions
  async function fetchCards(columnId) {
    const res = await cardApi.list(columnId)
    cards.value[columnId] = res.data
    return res.data
  }

  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    if (!cards.value[columnId]) cards.value[columnId] = []
    cards.value[columnId] = [...cards.value[columnId], res.data]
    // Refresh this column's count on the owning column object.
    const col = columns.value.find(c => c.id === columnId)
    if (col) col.card_count = (col.card_count || 0) + 1
    return res.data
  }

  async function updateCard(cardId, data) {
    const res = await cardApi.update(cardId, data)
    // Update card in the local state
    for (const colId in cards.value) {
      const idx = cards.value[colId].findIndex(c => c.id === cardId)
      if (idx !== -1) {
        cards.value[colId][idx] = res.data
        break
      }
    }
    return res.data
  }

  async function deleteCard(cardId) {
    await cardApi.delete(cardId)
    // Re-fetch from the server so positions/counts match the canonical state
    // instead of being inferred locally.
    if (currentBoard.value) {
      await fetchAllCards(currentBoard.value.id)
    }
  }

  // Coalesce concurrent move attempts for the same card (Sortable fires end
  // on both source and target lists) into one authoritative server round-trip.
  const movesInFlight = new Map()
  async function moveCard(cardId, targetColumnId, position) {
    const key = cardId
    if (movesInFlight.has(key)) return movesInFlight.get(key)

    const promise = (async () => {
      try {
        await cardApi.move(cardId, targetColumnId, position)
        // Rebuild all card buckets from the server: it alone knows the final
        // dense positions in source and target columns.
        if (currentBoard.value) {
          await fetchAllCards(currentBoard.value.id)
        }
        // Keep card_count badges aligned with actual buckets.
        for (const col of columns.value) {
          col.card_count = (cards.value[col.id] || []).length
        }
      } finally {
        movesInFlight.delete(key)
      }
    })()
    movesInFlight.set(key, promise)
    return promise
  }

  function clearBoard() {
    currentBoard.value = null
    columns.value = []
    cards.value = {}
  }

  return {
    boards, currentBoard, columns, cards, loading,
    fetchBoards, createBoard, deleteBoard,
    fetchColumns, fetchAllCards, addColumn, renameColumn, deleteColumn,
    reorderColumns,
    fetchCards, addCard, updateCard, deleteCard, moveCard,
    clearBoard
  }
})
