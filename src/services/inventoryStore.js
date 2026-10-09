import { SCAN_DEFAULTS } from "../core/scanDesk.js";
const DATABASE = 'card-rails'
const STORE = 'workspace'
const KEY = 'primary'

export const DEFAULT_LINKS = {
  pokoin: { linked: false, linkedVia: null },
  cardtrader: { linked: false, linkedVia: null },
  cardmarket: { linked: false, linkedVia: null },
  ebay: { linked: false, linkedVia: null },
}

export const EMPTY_WORKSPACE = {
  items: [],
  scanQueue: [],
  scanSettings: {...SCAN_DEFAULTS},
  book: [],
  events: [],
  links: DEFAULT_LINKS,
  pickedKeys: [],
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function cloneEmptyWorkspace() {
  return {
    ...EMPTY_WORKSPACE,
    links: Object.fromEntries(Object.entries(DEFAULT_LINKS).map(([id, link]) => [id, { ...link }])),
  }
}

export async function loadWorkspace() {
  if (typeof indexedDB === 'undefined') return cloneEmptyWorkspace()
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).get(KEY)
    request.onsuccess = () => {
      const saved = request.result
      resolve(saved ? { ...cloneEmptyWorkspace(), ...saved, links: { ...DEFAULT_LINKS, ...saved.links } } : cloneEmptyWorkspace())
    }
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

export async function saveWorkspace(workspace) {
  if (typeof indexedDB === 'undefined') return
  const database = await openDatabase()
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put({ ...workspace, savedAt: new Date().toISOString() }, KEY)
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
