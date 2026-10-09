import { listingTitle } from '../core/canonical.js'

/** Prepare documented Sell Inventory payloads. No remote publication is claimed. */
export function buildEbayListing(item, { title: customTitle } = {}) {
  const photo = item?.scanPhoto
  if (!photo?.id || (!photo.dataUrl && !photo.url)) throw new Error('A saved scan photo is required before this card can be listed on eBay.')
  const exactTitle = listingTitle(item, Infinity)
  const title = customTitle?.trim() || exactTitle
  const requiredParts=[item.identity.name,item.identity.setName,item.identity.number,item.language,item.condition,item.printing]
  if(customTitle && !requiredParts.every(part=>title.toLowerCase().includes(String(part).toLowerCase())))throw new Error('The title must contain the card name, set, number, language, condition and finish. You can shorten separators.')
  if (title.length > 80) throw new Error('The precise title exceeds eBay’s 80-character limit. Use shorter separators while preserving every card detail.')
  if (item.quantity < 1) throw new Error('There is no stock available for this eBay draft.')
  return {
    status: 'draft',
    requiredBeforePublication: ['eBay seller OAuth grant', 'Upload saved photo to eBay Picture Services; use returned URL in product.imageUrls', 'Category and marketplace', 'Merchant location and payment / fulfillment / return policy IDs', 'Category-specific condition ID and descriptors'],
    sku: item.id,
    exactTitle,
    photo: { id: photo.id, sha256: photo.sha256, source: photo.dataUrl || photo.url, role: 'scan' },
    inventoryItem: {
      condition: 'USED_VERY_GOOD',
      product: {
        title,
        description: exactTitle,
        aspects: { Game: [item.identity.game], Set: [item.identity.setName], 'Card Number': [item.identity.number], Language: [item.language], 'Card Condition': [item.condition], Finish: [item.printing] },
        imageUrls: [],
      },
      availability: { shipToLocationAvailability: { quantity: item.quantity } },
    },
    offer: { sku: item.id, format: 'FIXED_PRICE', availableQuantity: item.quantity, pricingSummary: { price: { value: Number(item.price || 0).toFixed(2), currency: item.currency || 'EUR' } } },
  }
}
