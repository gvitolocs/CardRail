import { railSize } from '../data/demo.js'

export function Overview({ pick, scanned, picked, onOpen }) {
  const lines = pick.lines
  const fan = lines.slice(0, 5)

  return (
    <section>
      <p className="kicker">Inventory operating system</p>
      <h1 className="page-title">One inventory. Every marketplace.</h1>
      <p className="page-sub">
        Scan the shelf once. CardTrader and Pokoin both read the same rail.
      </p>

      <div className="hero">
        <div className="fan" aria-hidden="true">
          {fan.map((line, index) => (
            <img
              key={line.key}
              src={line.item.art}
              alt=""
              style={{
                transform: `translateX(${(index - (fan.length - 1) / 2) * 46}px) rotate(${(index - (fan.length - 1) / 2) * 7}deg)`,
                zIndex: index,
              }}
            />
          ))}
        </div>
        <div className="stats">
          <div className="stat">
            <div className="num">
              {(railSize + scanned).toLocaleString('en-GB')}
            </div>
            <div className="lbl">cards on the rail</div>
          </div>
          <div className="stat">
            <div className="num">2</div>
            <div className="lbl">connectors</div>
          </div>
          <div className="stat">
            <div className="num">{lines.length}</div>
            <div className="lbl">
              lines in pick #{pick.number}
              {picked ? ' · synced' : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="path">
        {pick.stops.map((stop, index) => (
          <span key={stop}>
            {stop}
            {index < pick.stops.length - 1 && <span className="arrow"> → </span>}
          </span>
        ))}
      </div>

      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => onOpen('scan')}>
          Start scanning
        </button>
        <button type="button" className="btn" onClick={() => onOpen('pick')}>
          Open pick run
        </button>
        <button type="button" className="btn" onClick={() => onOpen('platforms')}>
          Connected platforms
        </button>
      </div>
    </section>
  )
}
