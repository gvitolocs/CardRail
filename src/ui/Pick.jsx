import { displayPhoto, eur, locationLabel, platformLabel } from '../core/canonical.js'
import { CardTraits } from './CardTraits.jsx'
import { PICK_SORTS } from '../engine/pickRun.js'

const SOURCES = [
  { id: 'rail', label: 'Card Rails' },
  { id: 'cardmarket', label: 'Cardmarket' },
  { id: 'ebay', label: 'eBay' },
  { id: 'all', label: 'All' },
  { id: 'pokoin', label: 'Pokoin' },
  { id: 'cardtrader', label: 'CardTrader' },
]

function groupSales(arrival) {
  const groups = []
  for (const line of arrival) {
    let group = groups.find((entry) => entry.id === line.orderId)
    if (!group) {
      group = {
        id: line.orderId,
        ref: line.orderRef,
        platform: line.platform,
        lines: [],
      }
      groups.push(group)
    }
    group.lines.push(line)
  }
  return groups
}

export function Pick({
  arrival,
  lines,
  sort,
  onSort,
  source,
  onSource,
  pickedKeys,
  onPick,
}) {
  const sales = groupSales(arrival)
  const remaining = lines.filter((line) => !pickedKeys.includes(line.key))
  const done = lines.filter((line) => pickedKeys.includes(line.key))
  const current = remaining[0] ?? null

  return (
    <section>
      <div className="sold-head">
        <div>
          <p className="kicker">Sold cards</p>
          <h1 className="page-title">Picking list</h1>
          <p className="page-sub">
            Orders stay in the channel they came from. The walk follows the shelf.
          </p>
        </div>
        <div className="source-pills" role="tablist" aria-label="Sale channel">
          {SOURCES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={source === item.id}
              className={'pill' + (source === item.id ? ' is-on' : '')}
              onClick={() => onSource(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {sales.length === 0 ? (
        <p className="picker-empty">No sold cards on this channel.</p>
      ) : (
        <ul className="sale-list">
          {sales.map((sale) => (
            <li className="sale" key={sale.id}>
              <header className="sale-top">
                <strong>{sale.ref}</strong>
                <span className={'src src-' + sale.platform}>{platformLabel(sale.platform)}</span>
                <span className="sale-count">
                  {sale.lines.length} {sale.lines.length === 1 ? 'card' : 'cards'}
                </span>
              </header>
              <ul className="sale-lines">
                {sale.lines.map((line) => (
                  <li key={line.key} className={pickedKeys.includes(line.key) ? 'is-picked' : ''}>
                    <img src={displayPhoto(line.item)} alt="" />
                    <span className="nm">{line.item.identity.name} ×{line.quantity}</span>
                    <span>{line.item.condition}</span>
                    <span>{line.item.language}</span>
                    <span className="sale-loc">{locationLabel(line.item.location)}</span>
                    <span className="sale-price">{eur(line.item.price)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="pick-tools">
        <h2>Walk</h2>
        <label className="sort-label">
          Sort
          <select value={sort} onChange={(event) => onSort(event.target.value)}>
            {PICK_SORTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {sort === 'location' && remaining.length > 0 && (
        <div className="pick-path">
          {remaining.map((line, index) => (
            <span key={line.key}>
              {line.position}
              {index < remaining.length - 1 && <span className="arrow"> → </span>}
            </span>
          ))}
        </div>
      )}

      {current ? (
        <div className="picker">
          <img className="picker-art" src={displayPhoto(current.item)} alt={current.item.identity.name} />
          <div className="picker-side">
            <div className="picker-loc">{locationLabel(current.item.location)}</div>
            <h2>{current.item.identity.name}</h2>
            <p className="picker-set">
              {current.item.identity.setName} · {current.item.identity.number}
            </p>
            <div className="picker-meta">
              <CardTraits item={current.item} />
              <span className={'src src-' + current.platform}>{platformLabel(current.platform)}</span>
              <span>{current.orderRef}</span>
              <b>{eur(current.item.price)}</b>
            </div>
            <button type="button" className="btn btn-primary picker-go" onClick={() => onPick(current.key)}>
              Pick
            </button>
            <p className="picker-left">
              {remaining.length} to pick · {done.length} picked
            </p>
          </div>
        </div>
      ) : (
        <p className="picker-empty">No more articles to pick</p>
      )}

      <div className="pick-cols">
        <div className="panel">
          <h3>To pick</h3>
          <ul className="line-list">
            {remaining.map((line) => (
              <li className={'line-item' + (line.key === current?.key ? ' is-current' : '')} key={line.key}>
                <span className="line-pos">{line.position}</span>
                <img src={displayPhoto(line.item)} alt="" />
                <div className="line-main">
                  <div className="nm">{line.item.identity.name}</div>
                  <div className="ref">
                    {line.orderRef} · {platformLabel(line.platform)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h3>Picked</h3>
          <ul className="line-list">
            {done.map((line) => (
              <li className="line-item is-done" key={line.key}>
                <span className="line-pos">{line.position}</span>
                <img src={displayPhoto(line.item)} alt="" />
                <div className="line-main">
                  <div className="nm">{line.item.identity.name}</div>
                  <div className="ref">{line.orderRef}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
