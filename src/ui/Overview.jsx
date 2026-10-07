import { eur, gameLabel, locationLabel, platformLabel } from '../core/canonical.js'
import { railSize } from '../data/demo.js'

const flow = ['Scan', 'Identify', 'Locate', 'Publish', 'Sale', 'Pick', 'Sync']

export function Overview({ items, pick, scanned, picked, onOpen }) {
  const sample = items.find((entry) => entry.location.position === 1284) ?? items[0]
  const stops = pick.stops.join(' → ')

  return (
    <div className="view">
      <header className="page-head">
        <p className="eyebrow">Inventory operating system for TCG sellers</p>
        <h1>One inventory. Every marketplace.</h1>
        <p className="lede">
          CardTrader and Pokoin are stops on the line. CardRail carries identity,
          stock, location, and orders between them. Pokoin is a client of the rail,
          the same way any other marketplace is.
        </p>
      </header>

      <ol className="flow">
        {flow.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <section className="split">
        <article className="panel">
          <header className="panel-head">
            <h2>Canonical record</h2>
            <span>What the core stores</span>
          </header>
          <p className="card-name">{sample.identity.name}</p>
          <p className="card-meta">
            {gameLabel(sample.identity.game)} · {sample.identity.setName} ·{' '}
            {sample.identity.number}
          </p>
          <dl className="record">
            <div>
              <dt>Language</dt>
              <dd>{sample.language}</dd>
            </div>
            <div>
              <dt>Condition</dt>
              <dd>{sample.condition}</dd>
            </div>
            <div>
              <dt>Printing</dt>
              <dd>{sample.printing}</dd>
            </div>
            <div>
              <dt>Quantity</dt>
              <dd>{sample.quantity}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>{eur(sample.price)}</dd>
            </div>
            <div>
              <dt>Physical location</dt>
              <dd>{locationLabel(sample.location)}</dd>
            </div>
            <div className="record-wide">
              <dt>External listings</dt>
              <dd>{sample.listings.map((listing) => platformLabel(listing.platform)).join(' · ') || 'None yet'}</dd>
            </div>
          </dl>
        </article>

        <div className="stack">
          <article className="panel stats">
            <p>
              <strong>{(railSize + scanned).toLocaleString('en-GB')}</strong>
              <span>cards on the rail</span>
            </p>
            <p>
              <strong>2</strong>
              <span>connectors live</span>
            </p>
            <p>
              <strong>{pick.lines.length}</strong>
              <span>lines in pick #{pick.number}</span>
            </p>
          </article>

          <article className="panel pick-teaser">
            <header className="panel-head">
              <h2>Pick Run #{pick.number}</h2>
              <span>{picked ? 'Synced' : 'Ready'}</span>
            </header>
            <p className="stops">{stops}</p>
            <p className="hint">
              Three CardTrader orders, one walk down Box 04. The shelf order is
              CardRail’s, not the marketplace’s.
            </p>
            <button type="button" className="btn" onClick={() => onOpen('pick')}>
              Open the pick run
            </button>
          </article>
        </div>
      </section>

      <section className="diagram" aria-label="Connectors around CardRail core">
        <span>CardTrader</span>
        <i />
        <span>Adapter</span>
        <i />
        <strong>CardRail Core</strong>
        <i />
        <span>Adapter</span>
        <i />
        <span>Pokoin</span>
      </section>

      <div className="actions">
        <button type="button" className="btn" onClick={() => onOpen('scan')}>
          Scan into Box 05
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onOpen('platforms')}>
          Connected platforms
        </button>
      </div>
    </div>
  )
}
