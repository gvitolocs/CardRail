/** Neutral record every connector must produce. Marketplaces never leak in. */

export function locationLabel(location) {
  return `Box ${location.box} → Row ${location.row} → position ${location.position}`
}

export function eur(amount) {
  return `€${amount.toFixed(2)}`
}

export function platformLabel(platform) {
  if (platform === 'cardtrader') return 'CardTrader'
  if (platform === 'pokoin') return 'Pokoin'
  return platform
}

export function gameLabel(game) {
  switch (game) {
    case 'pokemon':
      return 'Pokémon'
    case 'magic':
      return 'Magic'
    case 'onepiece':
      return 'One Piece'
    case 'lorcana':
      return 'Lorcana'
    default:
      return game
  }
}
