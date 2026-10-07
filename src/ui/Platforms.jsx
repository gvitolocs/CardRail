import { openSlots, samplePokoinSync } from '../data/demo.js'

const LIVE = [
  { id: 'cardtrader', name: 'CardTrader', status: 'Live' },
  { id: 'pokoin', name: 'Pokoin', status: 'Live' },
]

export function Platforms({ pending, onReserve }) {
  return (
    <section>
      <p className="kicker">Same core, another adapter</p>
      <h1 className="page-title">Connected platforms</h1>
      <p className="page-sub">
        Pokoin plugs in the same way CardTrader does. The next marketplace is another connector.
      </p>

      <div className="plat-list">
        {LIVE.map((platform) => (
          <div className="plat-row" key={platform.id}>
            <span className="dot dot-live" />
            <span className="plat-name">{platform.name}</span>
            <span className="spacer" />
            <span className="plat-status">{platform.status}</span>
          </div>
        ))}
        {openSlots
          .filter((slot) => pending.includes(slot.id))
          .map((slot) => (
            <div className="plat-row" key={slot.id}>
              <span className="dot dot-pending" />
              <span className="plat-name">{slot.name}</span>
              <span className="spacer" />
              <span className="plat-status">Pending</span>
            </div>
          ))}
      </div>

      <details className="add">
        <summary>+ Add marketplace</summary>
        <div className="slot-list">
          {openSlots.map((slot) => {
            const reserved = pending.includes(slot.id)
            return (
              <div className="slot" key={slot.id}>
                <span className="nm">
                  {slot.name}
                  <span className="page-sub" style={{ display: 'block', margin: 0 }}>
                    {slot.note}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onReserve(slot.id)}
                  disabled={reserved}
                >
                  {reserved ? 'Reserved' : 'Reserve'}
                </button>
              </div>
            )
          })}
        </div>
      </details>

      <p className="sync-note">
        Last Pokoin sync: <b>{samplePokoinSync.identity.name}</b>
      </p>
    </section>
  )
}
