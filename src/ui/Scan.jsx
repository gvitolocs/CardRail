import { useEffect, useState } from 'react'
import { locationLabel } from '../core/canonical.js'
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
    ? scanned.find((entry) => entry.identity.name === current.name && entry.identity.number === current.number)
    : null
  const finished = scanned.length >= scanQueue.length

  return (
    <section>
      <p className="kicker">Rapid scan</p>
      <h1 className="page-title">Capture the aisle.</h1>
      <p className="page-sub">
        The rail reads the card, then stamps a shelf position. Marketplaces are not involved yet.
      </p>

      <div className="scan-wrap">
        <div className="scan-stage">
          <div className="phase">{phase === 'idle' ? 'Ready' : phase}</div>
          {current && (phase === 'reading' || phase === 'resolved') ? (
            <img className="scan-art" src={current.art} alt={current.name} />
          ) : (
            <div className="scan-idle">{finished ? 'Aisle captured' : 'Ready to scan'}</div>
          )}
          {phase === 'resolved' && placed && (
            <div className="pill">{locationLabel(placed.location)}</div>
          )}
          {current && phase !== 'idle' && phase !== 'done' && (
            <>
              <p className="scan-name">{current.name}</p>
              <p className="scan-meta">
                {current.setName} · {current.number}
              </p>
            </>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setRunning(true)}
            disabled={running || finished}
          >
            {finished ? 'Aisle captured' : 'Start rapid scan'}
          </button>
        </div>

        <div className="session">
          <h3>
            Session · {scanned.length} / {scanQueue.length}
          </h3>
          {scanned.length === 0 ? (
            <p className="page-sub" style={{ margin: 0 }}>
              Nothing in Box 05 yet.
            </p>
          ) : (
            <ul className="session-list">
              {scanned.map((entry) => (
                <li className="session-item" key={entry.id}>
                  <img src={entry.art} alt="" />
                  <div>
                    <div className="nm">{entry.identity.name}</div>
                    <div className="loc">{locationLabel(entry.location)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
