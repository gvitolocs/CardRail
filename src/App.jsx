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

const stations = [
  ['overview', 'Overview'],
  ['scan', 'Scan'],
  ['inventory', 'Inventory'],
  ['pick', 'Pick run'],
  ['platforms', 'Platforms'],
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

  return (
    <div className="app">
      <aside className="rail">
        <div className="mark">
          <span className="mark-kicker">Inventory OS</span>
          <strong>CardRail</strong>
        </div>
        <ol className="stations">
          {stations.map(([id, label]) => (
            <li key={id} className={view === id ? 'is-active' : ''}>
              <button type="button" onClick={() => setView(id)}>
                {label}
              </button>
            </li>
          ))}
        </ol>
        <p className="rail-status">
          <i className={picked ? 'dot dot-on' : 'dot'} />
          {picked ? 'Pick run synced' : 'Core online'}
          <span>
            {(railSize + scanned).toLocaleString('en-GB')} cards
          </span>
        </p>
      </aside>
      <main className="stage">
        {view === 'overview' && (
          <Overview
            items={items}
            pick={pick}
            scanned={scanned}
            picked={picked}
            onOpen={setView}
          />
        )}
        {view === 'scan' && <Scan scanned={items.filter((entry) => entry.source === 'scan')} onScan={addScan} />}
        {view === 'inventory' && <Inventory items={items} />}
        {view === 'pick' && (
          <Pick pick={pick} picked={picked} onConfirm={confirmPick} />
        )}
        {view === 'platforms' && (
          <Platforms pending={pending} onReserve={reserveConnector} />
        )}
      </main>
    </div>
  )
}
