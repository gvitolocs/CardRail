import { eur, gameLabel, locationLabel } from '../core/canonical.js'

export function Inventory({ items, query }) {
  const needle = (query || '').trim().toLowerCase()
  const filtered = items
    .slice()
    .sort((a, b) => a.location.position - b.location.position)
    .filter((entry) => {
      if (!needle) return true
      const hay = [
        entry.identity.name,
        entry.identity.setName,
        entry.identity.number,
        gameLabel(entry.identity.game),
        locationLabel(entry.location),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(needle)
    })

  return (
    <section>
      <p className="kicker">Box 04 in focus</p>
      <h1 className="page-title">{needle ? `Results for “${query.trim()}”` : 'Physical inventory'}</h1>
      <p className="page-sub">
        {filtered.length} cards on this aisle. Location stays on the rail. Listings point back out.
      </p>
      <div className="grid">
        {filtered.map((entry) => (
          <article key={entry.id} className={'tile' + (entry.quantity === 0 ? ' is-out' : '')}>
            <img className="photo" src={entry.art} alt={entry.identity.name} />
            <div className="badges">
              <img className="chip" src={entry.chip} alt={entry.condition} />
              <img className="flag" src={entry.flag} alt={entry.language} />
              <span className="game">{gameLabel(entry.identity.game)}</span>
            </div>
            <div>
              <div className="tile-name">{entry.identity.name}</div>
              <div className="tile-set">
                {entry.identity.setName}
                {entry.identity.number ? ` · ${entry.identity.number}` : ''}
              </div>
            </div>
            <div className="tile-loc">{locationLabel(entry.location)}</div>
            <div className="listings">
              {entry.listings.length === 0 ? (
                <span className="listing">On rail</span>
              ) : (
                entry.listings.map((listing) => (
                  <span className="listing" key={listing.externalId}>
                    {listing.platform === 'cardtrader' ? 'CardTrader' : 'Pokoin'}
                    {listing.quantity === 0 ? ' · 0' : ''}
                  </span>
                ))
              )}
            </div>
            <div className="tile-foot">
              <span className="price">{eur(entry.price)}</span>
              <span className="qty">× {entry.quantity}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
