// eslint-disable-next-line no-unused-expressions -- Playwright CLI evaluates this callback.
async page => {
  const result=await page.evaluate(async()=>{
    const photo=document.querySelector('.scan-photo').src
    const blob=await(await fetch(photo)).blob()
    const results=[]
    for(const origin of ['https://pokoin.com','https://api.pokoin.com']){
      const form=new FormData();form.append('file',blob,'card.jpg')
      try{const response=await fetch(origin+'/api/scan/identify?catalog=pokemon_western&top_k=5',{method:'POST',body:form,credentials:'omit'});const data=await response.json();results.push({origin,status:response.status,ok:data.ok,name:data.hits?.[0]?.name,error:data.error})}catch(e){results.push({origin,error:e.message})}
    }
    return results
  })
  if(!result.some(r=>r.ok && r.name==='Bulbasaur'))throw new Error(JSON.stringify(result))
  return result
}
