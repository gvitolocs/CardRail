import { useCallback, useMemo, useState } from 'react'
import { fromCardTraderOrders } from './connectors/cardtrader.js'
import { buildPickRun } from './engine/pickRun.js'
import {
  cardTraderOrders,
  railSize,
  resolveScan,
  seedInventory,
} from './data/demo.js'
import { Overview } from './ui/Overview.jsx'
import { Scan } from './ui/Scan.jsx'
import { Inventory } from './ui/Inventory.jsx'
import { Pick } from './ui/Pick.jsx'
import { Platforms } from './ui/Platforms.jsx'

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'scan', label: 'Scan' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'pick', label: 'Pick run' },
  { id: 'platforms', label: 'Platforms' },
]

export default function App() {
  const [view, setView] = useState('overview')
  const [items, setItems] = useState(() =>
    seedInventory.map((entry) => ({
      ...entry,
      listings: entry.listings.map((listing) => ({ ...listing })),
      location: { ...entry.location },
      identity: { ...entry.identity },
    })),
  )
  const [picked, setPicked] = useState(false)
  const [pending, setPending] = useState([])
  const [query, setQuery] = useState('')

  const orders = useMemo(() => fromCardTraderOrders(cardTraderOrders), [])
  const pick = useMemo(() => buildPickRun(orders, items), [orders, items])
  const scanned = items.filter((entry) => entry.source === 'scan').length

  const addScan = useCallback((raw) => {
    setItems((prev) => {
      const next = resolveScan(raw, prev)
      return next ? [...prev, next] : prev
    })
  }, [])

  function confirmPick() {
    if (picked) return
    const ids = new Set(pick.lines.map((line) => line.item.id))
    setItems((prev) =>
      prev.map((entry) => {
        if (!ids.has(entry.id)) return entry
        return {
          ...entry,
          quantity: Math.max(0, entry.quantity - 1),
          listings: entry.listings.map((listing) => ({
            ...listing,
            quantity: Math.max(0, listing.quantity - 1),
          })),
        }
      }),
    )
    setPicked(true)
  }

  function reserveConnector(id) {
    setPending((current) => (current.includes(id) ? current : [...current, id]))
  }

  function onSearch(event) {
    const value = event.target.value
    setQuery(value)
    if (value.trim()) setView('inventory')
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" width={28} height={28} alt="" />
          <span className="wordmark">Card Rails</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={'nav-btn' + (view === item.id ? ' is-active' : '')}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <input
          className="search"
          placeholder="Search cards, sets, locations…"
          value={query}
          onChange={onSearch}
          aria-label="Search the rail"
        />
        <div className="count">
          <b>{(railSize + scanned).toLocaleString('en-GB')}</b> cards
        </div>
      </header>
      <main className="main">
        {view === 'overview' && (
          <Overview
            pick={pick}
            scanned={scanned}
            picked={picked}
            onOpen={setView}
          />
        )}
        {view === 'scan' && (
          <Scan
            scanned={items.filter((entry) => entry.source === 'scan')}
            onScan={addScan}
          />
        )}
        {view === 'inventory' && <Inventory items={items} query={query} />}
        {view === 'pick' && (
          <Pick pick={pick} picked={picked} onConfirm={confirmPick} />
        )}
        {view === 'platforms' && (
          <Platforms pending={pending} onReserve={reserveConnector} />
        )}
      </main>
    </>
  )
}
