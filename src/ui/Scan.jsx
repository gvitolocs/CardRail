import { useEffect, useState } from 'react'
import { eur, gameLabel, locationLabel } from '../core/canonical.js'
import { scanQueue } from '../data/demo.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function Scan({ scanned, onScan }) {
  const [running, setRunning] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const [phase, setPhase] = useState('idle')

  useEffect(() => {
    if (!running) return undefined
    let cancelled = false

    async function burst() {
      for (let index = 0; index < scanQueue.length; index += 1) {
        if (cancelled) return
        setCursor(index)
        setPhase('reading')
        await wait(520)
        if (cancelled) return
        onScan(scanQueue[index])
        setPhase('resolved')
        await wait(640)
      }
      if (!cancelled) {
        setRunning(false)
        setPhase('done')
      }
    }

    burst()
    return () => {
      cancelled = true
    }
  }, [running, onScan])

  const current = cursor >= 0 ? scanQueue[cursor] : null
  const placed = current
    ? scanned.find(
        (entry) =>
          entry.identity.name === current.name && entry.identity.number === current.number,
      )
    : null

  return (
    <div className="view">
      <header className="page-head">
        <p className="eyebrow">Scan → inventory</p>
        <h1>Read the card. Stamp the shelf.</h1>
        <p className="lede">
          Recognition lands in the same canonical record as an import. A scan does
          not know about CardTrader or Pokoin. It only adds stock and a physical
          position.
        </p>
      </header>

      <section className="split scan-layout">
        <article className="viewfinder">
          <div className="finder-frame">
            <span className="bracket tl" />
            <span className="bracket tr" />
            <span className="bracket bl" />
            <span className="bracket br" />
            {phase === 'done' && (
              <p className="finder-idle">{scanned.length} cards written to the rail.</p>
            )}
            {phase === 'idle' && <p className="finder-idle">Box 05 is clear.</p>}
            {current && (phase === 'reading' || phase === 'resolved') && (
              <div className={phase === 'reading' ? 'finder-card is-reading' : 'finder-card'}>
                <p className="eyebrow">{phase === 'reading' ? 'Resolving' : 'Identified'}</p>
                <h2>{current.name}</h2>
                <p>
                  {gameLabel(current.game)} · {current.setName} · {current.number}
                </p>
                <p>
                  {current.language} · {current.condition} · {current.printing}
                </p>
                {phase === 'resolved' && placed && (
                  <p className="stamp">{locationLabel(placed.location)}</p>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn"
            disabled={running || scanned.length >= scanQueue.length}
            onClick={() => {
              setPhase('reading')
              setRunning(true)
            }}
          >
            {scanned.length >= scanQueue.length ? 'Aisle captured' : 'Start rapid scan'}
          </button>
        </article>

        <article className="panel">
          <header className="panel-head">
            <h2>This session</h2>
            <span>
              {scanned.length} / {scanQueue.length}
            </span>
          </header>
          {scanned.length === 0 ? (
            <p className="hint">Nothing on Box 05 yet. The burst writes six cards in shelf order.</p>
          ) : (
            <ol className="session">
              {scanned.map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>{entry.identity.name}</strong>
                    <span>
                      {entry.language} · {entry.printing} · {eur(entry.price)}
                    </span>
                  </div>
                  <em>{locationLabel(entry.location)}</em>
                </li>
              ))}
            </ol>
          )}
        </article>
      </section>
    </div>
  )
}
