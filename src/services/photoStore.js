function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Photo could not be read.'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Photo could not be decoded.'))
    image.src = dataUrl
  })
}

async function digest(value) {
  if (!globalThis.crypto?.subtle) return `${value.length}-${Date.now().toString(36)}`
  const bytes = new TextEncoder().encode(value)
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function storeScanPhoto(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose a JPG, PNG, HEIC, or WebP photo.')
  const original = await readFile(file)
  const image = await loadImage(original)
  const maximum = 1600
  const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, width, height)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.84)
  const sha256 = await digest(dataUrl)
  return {
    id: `photo_${sha256.slice(0, 18)}`,
    role: 'scan',
    dataUrl,
    sha256,
    bytes: Math.ceil((dataUrl.length * 3) / 4),
    width,
    height,
    capturedAt: new Date().toISOString(),
    originalName: file.name || 'camera.jpg',
  }
}
