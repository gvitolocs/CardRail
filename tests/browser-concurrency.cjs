// eslint-disable-next-line no-unused-expressions -- Playwright CLI callback.
async page => {
  const result = await page.evaluate(async () => {
    const read = async () => (await fetch('/api/v1/inventory')).json()
    const before = await read()
    const id = before.items[0].id
    const adjust = async delta => {
      const response = await fetch('/api/v1/inventory', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'adjust',id,delta,idempotencyKey:crypto.randomUUID()})})
      if(!response.ok) throw new Error((await response.json()).error)
      return response.json()
    }
    await Promise.all([adjust(1),adjust(1)])
    const after = await read()
    if(after.items[0].quantity !== before.items[0].quantity+2) throw new Error('Concurrent stock update lost')
    await adjust(-2)
    return {concurrentAdjustments:2,lostUpdates:0,photoUrl:before.items[0].scanPhoto.url}
  })
  const isolated = await page.context().browser().newContext()
  const other = await isolated.newPage()
  await other.goto(page.url())
  const isolation = await other.evaluate(async url => {
    const inventory = await (await fetch('/api/v1/inventory')).json()
    const photo = await fetch(url)
    return {rows:inventory.items.length,photoStatus:photo.status}
  },result.photoUrl)
  await isolated.close()
  if(isolation.rows !== 0 || isolation.photoStatus !== 404) throw new Error('Private workspace isolation failed')
  return { concurrentAdjustments:result.concurrentAdjustments,lostUpdates:0,isolatedRows:isolation.rows,privatePhotoStatus:isolation.photoStatus }
}
