// eslint-disable-next-line no-unused-expressions -- Playwright CLI evaluates this callback.
async page => {
  await page.getByRole('img',{name:'QR code to connect your phone'}).waitFor();
  if(await page.getByLabel('Batch location',{exact:true}).inputValue()!=='') throw new Error('New inventory has a fabricated location');
  await page.getByRole('img',{name:'QR code to connect your phone'}).locator('image').waitFor({state:'attached'});
  await page.getByRole('img',{name:'QR code to connect your phone'}).screenshot({path:'/tmp/cardrails-pairing-qr.png',scale:'css'});
  const hash=await page.evaluate(async()=>{const url=document.querySelector('.desk-qr a').href;const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');});
  return {qrVisible:true,trainIcon:true,blankInitialLocation:true,urlHash:hash};
}
