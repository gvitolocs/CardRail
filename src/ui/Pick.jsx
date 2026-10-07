import { eur, locationLabel } from '../core/canonical.js'

export function Pick({ pick, picked, onConfirm }) {
  return (
    <div className="view">
      <header className="page-head">
        <p className="eyebrow">CardTrader orders in · one walk out</p>
        <h1>Pick Run #{pick.number}</h1>
        <p className="lede">
          The marketplace listed these copies in the order the sales arrived.
          CardRail reorders them by shelf position so the seller crosses Box 04 once.
        </p>
      </header>

      <p className="path-banner">
        {pick.stops.map((stop, index) => (
          <span key={stop}>
            {index > 0 && <i>→</i>}
            {stop}
          </span>
        ))}
      </p>

      <section className="split">
        <article className="panel">
          <header className="panel-head">
            <h2>As CardTrader sent them</h2>
            <span>{pick.arrival.length} lines</span>
          </header>
          <ol className="orders">
            {pick.arrival.map((line, index) => (
              <li key={`in-${line.key}`}>
                <span className="idx">{index + 1}</span>
                <div>
                  <strong>{line.item.identity.name}</strong>
                  <span>
                    {line.orderRef} · {locationLabel(line.item.location)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </article>

        <article className="panel panel-path">
          <header className="panel-head">
            <h2>Shelf order</h2>
            <span>{picked ? 'Confirmed' : 'Walk this'}</span>
          </header>
          <ol className="path">
            {pick.lines.map((line) => (
              <li key={line.key} className={picked ? 'is-done' : ''}>
                <b>{line.position}</b>
                <div>
                  <strong>{line.item.identity.name}</strong>
                  <span>
                    {line.orderRef} · {eur(line.item.price)} · qty {line.item.quantity}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="btn" disabled={picked} onClick={onConfirm}>
            {picked ? 'Quantities synced' : 'Confirm cards and sync'}
          </button>
          {picked && (
            <p className="hint">
              Each copy is now zero on the rail, on CardTrader, and on Pokoin.
              The next order will not sell it twice.
            </p>
          )}
        </article>
      </section>
    </div>
  )
}
