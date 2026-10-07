import { eur, locationLabel } from '../core/canonical.js'

export function Pick({ pick, picked, onConfirm }) {
  return (
    <section>
      <p className="kicker">CardTrader orders in</p>
      <h1 className="page-title">Pick Run #{pick.number}</h1>
      <p className="page-sub">
        The sales arrived in marketplace order. The walk below follows the shelf.
      </p>

      <div className="pick-path">
        {pick.stops.map((stop, index) => (
          <span key={stop}>
            {stop}
            {index < pick.stops.length - 1 && <span className="arrow"> → </span>}
          </span>
        ))}
      </div>

      <div className="pick-cols">
        <div className="panel">
          <h3>As CardTrader sent them</h3>
          <ul className="arrival-list">
            {pick.arrival.map((line, index) => (
              <li className="arrival-item" key={`in-${line.key}`}>
                <span className="idx">{index + 1}</span>
                <img src={line.item.art} alt="" />
                <div className="arrival-main">
                  <div className="nm">{line.item.identity.name}</div>
                  <div className="ref">{line.orderRef}</div>
                </div>
                <span className="arrival-loc">{locationLabel(line.item.location)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <h3>Shelf order</h3>
          <ul className="line-list">
            {pick.lines.map((line) => (
              <li className="line-item" key={line.key}>
                <span className="line-pos">{line.position}</span>
                <img src={line.item.art} alt="" />
                <div className="line-main">
                  <div className="nm">{line.item.identity.name}</div>
                  <div className="ref">{line.orderRef}</div>
                </div>
                <div className="line-right">
                  <div className="p">{eur(line.item.price)}</div>
                  <div className="q">× {line.item.quantity}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="actions" style={{ marginTop: 22 }}>
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={picked}>
          {picked ? 'Quantities synced' : 'Confirm cards and sync'}
        </button>
      </div>
    </section>
  )
}
