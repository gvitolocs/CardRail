import { useMemo, useState } from 'react'
import { eur, gameLabel, locationLabel } from '../core/canonical.js'
import { railSize } from '../data/demo.js'

export function Inventory({ items }) {
  const [query, setQuery] = useState('')
  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const sorted = items.slice().sort((a, b) => a.location.position - b.location.position)
    if (!needle) return sorted
    return sorted.filter((entry) => {
      const blob = [
        entry.identity.name,
        entry.identity.setName,
        entry.identity.number,
        entry.language,
        entry.printing,
        locationLabel(entry.location),
        gameLabel(entry.identity.game),
      ]
        .join(' ')
        .toLowerCase()
      return blob.includes(needle)
    })
  }, [items, query])

  return (
    <div className="view">
      <header className="page-head">
        <p className="eyebrow">Box 04 in focus · rail holds {railSize.toLocaleString('en-GB')}</p>
        <h1>Physical inventory</h1>
        <p className="lede">
          Location belongs to CardRail. Listings are pointers back to whichever
          marketplace currently offers the copy.
        </p>
      </header>

      <label className="search">
        <span>Find a card or a position</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Umbreon, 1284, Lorcana…"
        />
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Card</th>
              <th>Print</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Location</th>
              <th>Listings</th>
            </tr>
          </thead>
          <tbody>
            {listed.map((entry) => (
              <tr key={entry.id} className={entry.quantity === 0 ? 'is-out' : ''}>
                <td>
                  <strong>{entry.identity.name}</strong>
                  <span>
                    {gameLabel(entry.identity.game)} · {entry.identity.setName} ·{' '}
                    {entry.identity.number}
                  </span>
                </td>
                <td>
                  {entry.language} · {entry.condition}
                  <span>{entry.printing}</span>
                </td>
                <td className="num">{entry.quantity}</td>
                <td className="num">{eur(entry.price)}</td>
                <td className="mono">{locationLabel(entry.location)}</td>
                <td>
                  {entry.listings.length === 0 ? (
                    <span className="pill">On rail</span>
                  ) : (
                    entry.listings.map((listing) => (
                      <span key={listing.externalId} className={`pill pill-${listing.platform}`}>
                        {listing.platform === 'cardtrader' ? 'CardTrader' : 'Pokoin'}
                        {listing.quantity === 0 ? ' · 0' : ''}
                      </span>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {listed.length === 0 && <p className="hint empty">No card matches that search.</p>}
      </div>
    </div>
  )
}
