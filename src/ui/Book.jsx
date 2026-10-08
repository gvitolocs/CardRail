import { platformLabel } from '../core/canonical.js'

function when(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

export function Book({ rows }) {
  return (
    <section>
      <p className="kicker">Stock book</p>
      <h1 className="page-title">Every sale is a line.</h1>
      <p className="page-sub">
        Selling a card books the quantity out, the shelf code, and the channel. The same card is not booked twice for one order.
      </p>
      <div className="book">
        <table className="book-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Card</th>
              <th>Location</th>
              <th>Out</th>
              <th>Channel</th>
              <th>Order</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6}>No lines yet. Record a sale in Inventory to write the book.</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{when(row.at)}</td>
                <td>{row.name}</td>
                <td>{row.location || '—'}</td>
                <td className="book-out">{row.delta}</td>
                <td><span className="book-channel">{platformLabel(row.channel)}</span></td>
                <td>{row.orderRef || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
