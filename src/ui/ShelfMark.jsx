import { useMemo } from 'react'
import { locationCode } from '../core/canonical.js'
import { code128Runs } from '../core/code128.js'
import { encodeQr, qrLogoLayout, qrPath } from '../core/qr.js'

export function ShelfMark({ location, caption }) {
  const code = locationCode(location)
  const qr = useMemo(() => {
    const encoded = encodeQr(`cardrails:${code}`, { ecc: 'H' })
    const logo = qrLogoLayout(encoded, { logoRatio: 0.18, padRatio: 0.26 })
    return { d: qrPath(encoded), ...logo }
  }, [code])
  const bars = useMemo(() => code128Runs(code), [code])
  const logoX = qr.cx - qr.logo / 2
  const logoY = qr.cy - qr.logo / 2

  if (!code) return <p className="shelf-caption">Set and confirm the physical location to create its shelf label.</p>
  return (
    <figure className="shelf-mark">
      <div className="shelf-qr">
        <svg viewBox={`0 0 ${qr.view} ${qr.view}`} role="img" aria-label={`QR ${code}`} shapeRendering="crispEdges">
          <rect width={qr.view} height={qr.view} fill="#fff" />
          <path d={qr.d} fill="#111" />
          <circle cx={qr.cx} cy={qr.cy} r={qr.pad / 2} fill="#fff" />
          <image href="/favicon.svg" x={logoX} y={logoY} width={qr.logo} height={qr.logo} />
        </svg>
      </div>
      <div className="shelf-side">
        <div className="shelf-code">{code}</div>
        <div className="shelf-bars">
          <svg viewBox={`0 0 ${bars.width} 40`} role="img" aria-label={`Barcode ${code}`} preserveAspectRatio="none">
            <rect width={bars.width} height="40" fill="#fff" />
            {bars.runs.map((run) => (
              <rect key={run.x} x={run.x} y="0" width={run.width} height="40" fill="#111" />
            ))}
          </svg>
        </div>
        <figcaption className="shelf-caption">{caption}</figcaption>
      </div>
    </figure>
  )
}
