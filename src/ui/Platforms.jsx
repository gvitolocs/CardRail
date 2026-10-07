import { samplePokoinSync, openSlots } from '../data/demo.js'

const live = [
  {
    id: 'cardtrader',
    name: 'CardTrader',
    detail: 'Seller account · orders and listings',
  },
  {
    id: 'pokoin',
    name: 'Pokoin',
    detail: 'First client of the rail · not the product',
  },
]

export function Platforms({ pending, onReserve }) {
  return (
    <div className="view">
      <header className="page-head">
        <p className="eyebrow">Same core, another adapter</p>
        <h1>Connected platforms</h1>
        <p className="lede">
          CardRail does not belong to Pokoin. Pokoin plugs in the way CardTrader
          does. The next marketplace is another connector, not a rewrite.
        </p>
      </header>

      <ul className="platforms">
        {live.map((platform) => (
          <li key={platform.id}>
            <i className="dot dot-on" />
            <div>
              <strong>{platform.name}</strong>
              <span>{platform.detail}</span>
            </div>
            <em>Live</em>
          </li>
        ))}
        {openSlots
          .filter((slot) => pending.includes(slot.id))
          .map((slot) => (
            <li key={slot.id}>
              <i className="dot dot-wait" />
              <div>
                <strong>{slot.name}</strong>
                <span>Connector slot reserved · {slot.note}</span>
              </div>
              <em>Pending</em>
            </li>
          ))}
      </ul>

      <details className="add-market">
        <summary>+ Add marketplace</summary>
        <ul>
          {openSlots.map((slot) => (
            <li key={slot.id}>
              <div>
                <strong>{slot.name}</strong>
                <span>{slot.note}</span>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending.includes(slot.id)}
                onClick={() => onReserve(slot.id)}
              >
                {pending.includes(slot.id) ? 'Reserved' : 'Reserve connector'}
              </button>
            </li>
          ))}
        </ul>
      </details>

      <article className="panel sync-sample">
        <header className="panel-head">
          <h2>Last Pokoin sync, after the adapter</h2>
          <span>canonical</span>
        </header>
        <p className="card-name">{samplePokoinSync.identity.name}</p>
        <p className="card-meta">
          {samplePokoinSync.identity.setName} · {samplePokoinSync.identity.number} ·{' '}
          {samplePokoinSync.language} · {samplePokoinSync.condition} ·{' '}
          {samplePokoinSync.printing}
        </p>
        <p className="hint">
          The raw Pokoin listing id {samplePokoinSync.externalId} stays inside the
          connector. The core only keeps identity, condition, printing, quantity, and price.
        </p>
      </article>
    </div>
  )
}
