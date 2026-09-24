import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

export const useBoardStore = defineStore('board', () => {
  const boards = ref([])
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const loading = ref(false)

  // Canonical position rule (single source of truth for every entry point):
  // position is the dense 0-based index of a column inside its board, and of
  // a card inside its column. The array ordering defines the position; after
  // any drag/delete/create operation the local state is normalized to match
  // the array order BEFORE syncing, and on any sync failure the whole board
  // is reloaded so the UI can never diverge from the server.
  function normalizeColumnPositions() {
    columns.value.forEach((col, i) => {
      col.position = i
    })
  }

  function normalizeCardPositions(columnId) {
    const list = cards.value[columnId]
    if (list) {
      list.forEach((card, i) => {
        card.column_id = columnId
        card.position = i
      })
    }
  }

  async function reloadBoard(boardId) {
    await fetchColumns(boardId)
    await fetchAllCards(boardId)
  }

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
      columns.value = res.data
      // Reconcile the cards map without discarding already-loaded cards.
      const nextCards = {}
      for (const col of res.data) {
        nextCards[col.id] = cards.value[col.id] || []
      }
      cards.value = nextCards
    } finally {
      loading.value = false
    }
  }

  async function addColumn(boardId, name) {
    const res = await columnApi.create(boardId, name)
    columns.value.push(res.data)
    // Server appends at the end; the array order is the canonical order.
    normalizeColumnPositions()
    cards.value[res.data.id] = []
    return res.data
  }

  async function renameColumn(colId, name) {
    const res = await columnApi.update(colId, { name })
    const idx = columns.value.findIndex(c => c.id === colId)
    if (idx !== -1) {
      // Merge server data but keep the local canonical position/order.
      columns.value[idx] = { ...columns.value[idx], ...res.data, position: idx }
    }
    return res.data
  }

  async function deleteColumn(colId) {
    try {
      await columnApi.delete(colId)
    } catch (err) {
      if (currentBoard.value) await reloadBoard(currentBoard.value.id)
      throw err
    }
    columns.value = columns.value.filter(c => c.id !== colId)
    delete cards.value[colId]
    // Local positions must be renumbered locally as well: otherwise the next
    // drag would judge stale positions and skip required updates.
    normalizeColumnPositions()
  }

  // The caller has already arranged columns.value in the desired visual
  // order (vuedraggable mutates the array in place). Move exactly the one
  // dragged column to its canonical index; positions of the other columns
  // derive from the same array-order rule. On failure, reload everything.
  async function reorderColumn(colId) {
    const newPosition = columns.value.findIndex(c => c.id === colId)
    if (newPosition === -1) return
    normalizeColumnPositions()
    try {
      const res = await columnApi.update(colId, { position: newPosition })
      const idx = columns.value.findIndex(c => c.id === colId)
      if (idx !== -1) {
        columns.value[idx] = { ...columns.value[idx], ...res.data, position: newPosition }
      }
    } catch (err) {
      if (currentBoard.value) await reloadBoard(currentBoard.value.id)
      throw err
    }
  }

  // Card actions
  async function fetchCards(columnId) {
    const res = await cardApi.list(columnId)
    cards.value[columnId] = res.data
    return res.data
  }

  async function fetchAllCards(boardId) {
    const cols = columns.value
    const promises = cols.map(col => cardApi.list(col.id))
    const results = await Promise.all(promises)
    const nextCards = {}
    cols.forEach((col, i) => {
      nextCards[col.id] = results[i].data
    })
    cards.value = nextCards
  }

  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    if (!cards.value[columnId]) cards.value[columnId] = []
    cards.value[columnId].push(res.data)
    normalizeCardPositions(columnId)
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
    try {
      await cardApi.delete(cardId)
    } catch (err) {
      if (currentBoard.value) await reloadBoard(currentBoard.value.id)
      throw err
    }
    let deletedFrom = null
    for (const colId in cards.value) {
      const before = cards.value[colId].length
      cards.value[colId] = cards.value[colId].filter(c => c.id !== cardId)
      if (cards.value[colId].length !== before) deletedFrom = colId
    }
    if (deletedFrom !== null) normalizeCardPositions(deletedFrom)
  }

  // Single canonical entry for card moves: same-column reorder, cross-column
  // drag and the dropdown/detail "Move to..." all go through here. The local
  // arrays are reordered to match the visual drop order first, positions are
  // normalized from array indexes, then synced in one API call.
  async function moveCard(cardId, targetColumnId, position) {
    const sourceListKey = Object.keys(cards.value).find(
      colId => cards.value[colId].some(c => c.id === cardId)
    )
    if (sourceListKey === undefined) {
      if (currentBoard.value) await reloadBoard(currentBoard.value.id)
      throw new Error('Card not found in local board state')
    }

    const sourceList = cards.value[sourceListKey]
    const fromIndex = sourceList.findIndex(c => c.id === cardId)
    const movedCard = sourceList.splice(fromIndex, 1)[0]

    if (!cards.value[targetColumnId]) cards.value[targetColumnId] = []
    const targetList = cards.value[targetColumnId]
    // Clamp the drop index into the valid slots of the target list; the
    // server applies the identical rule.
    const clamped = Math.max(0, Math.min(position ?? targetList.length, targetList.length))
    targetList.splice(clamped, 0, movedCard)

    normalizeCardPositions(Number(sourceListKey))
    if (Number(sourceListKey) !== targetColumnId) normalizeCardPositions(targetColumnId)

    try {
      const res = await cardApi.move(cardId, targetColumnId, clamped)
      // Adopt the server's canonical record for the moved card.
      const finalList = cards.value[targetColumnId]
      const idx = finalList.findIndex(c => c.id === cardId)
      if (idx !== -1) finalList[idx] = res.data
    } catch (err) {
      if (currentBoard.value) await reloadBoard(currentBoard.value.id)
      throw err
    }
    return movedCard
  }

  function clearBoard() {
    currentBoard.value = null
    columns.value = []
    cards.value = {}
  }

  return {
    boards, currentBoard, columns, cards, loading,
    fetchBoards, createBoard, deleteBoard,
    fetchColumns, addColumn, renameColumn, deleteColumn, reorderColumn,
    fetchCards, fetchAllCards, addCard, updateCard, deleteCard, moveCard,
    reloadBoard, clearBoard
  }
})
