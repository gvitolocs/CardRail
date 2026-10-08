/**
 * Numeric dictionaries shared with the Card Rails API (`GET /v1/dictionary`) and the
 * iPhone/Android apps. The compact inventory and the compact import use these codes
 * instead of repeating strings for every copy. Append-only: never renumber.
 */
export const DICTIONARY_VERSION = 1

/** Code = index + 1. */
export const GAMES = ['pokemon', 'magic', 'yugioh', 'one_piece', 'lorcana', 'riftbound', 'vanguard', 'flesh_and_blood', 'dragon_ball_super', 'digimon', 'star_wars', 'union_arena', 'gundam', 'sorcery', 'palworld', 'cyberpunk']
/** L1 English, L2 Italian, … L5 Japanese. */
export const LANGUAGES = ['EN', 'IT', 'FR', 'DE', 'JP', 'ES', 'PT', 'ZH', 'KO']
export const CONDITIONS = ['M', 'NM', 'SP', 'MP', 'PL', 'PO']
/** Finishes outside this list travel as plain text. */
export const PRINTINGS = ['Standard', 'Holo', 'Reverse Holo']

export const FLAGS = { firstEdition: 1, signed: 2, altered: 4, collection: 8, imported: 16 }

export const encode = (table, value) => {
  const index = table.indexOf(value)
  return index < 0 ? null : index + 1
}
export const decode = (table, code) => (Number.isInteger(code) ? table[code - 1] ?? null : null)

const COMPACT_FIELDS = ['id', 'publicId', 'game', 'language', 'condition', 'printing', 'quantity', 'priceCents', 'box', 'row', 'position', 'end', 'version', 'flags']

/** One `GET /v1/inventory/compact` row → a plain copy (card details come from the blueprint). */
export function decodeCompactRow(row, boxes) {
  const v = Object.fromEntries(COMPACT_FIELDS.map((field, i) => [field, row[i]]))
  const extras = row.length > COMPACT_FIELDS.length ? row[COMPACT_FIELDS.length] : {}
  return {
    seq: v.id,
    publicId: v.publicId == null ? '' : String(v.publicId),
    game: decode(GAMES, v.game),
    language: decode(LANGUAGES, v.language),
    condition: decode(CONDITIONS, v.condition),
    printing: typeof v.printing === 'string' ? v.printing : decode(PRINTINGS, v.printing),
    quantity: v.quantity,
    price: v.priceCents / 100,
    location: v.box == null ? null : { box: boxes[v.box], row: String(v.row), position: v.position, end: v.end },
    version: v.version,
    firstEdition: (v.flags & FLAGS.firstEdition) !== 0,
    signed: (v.flags & FLAGS.signed) !== 0,
    altered: (v.flags & FLAGS.altered) !== 0,
    purpose: (v.flags & FLAGS.collection) !== 0 ? 'collection' : 'sale',
    imported: (v.flags & FLAGS.imported) !== 0,
    name: extras.n ?? null,
    setName: extras.s ?? null,
    number: extras.k ?? null,
    photoId: extras.p ?? null,
  }
}

/** A copy → one `POST /v1/inventory/import` row. */
export function encodeImportRow({ publicId, game, language, condition, printing, quantity, price = 0, firstEdition, signed, altered, purpose }) {
  const flags = (firstEdition ? FLAGS.firstEdition : 0) | (signed ? FLAGS.signed : 0) | (altered ? FLAGS.altered : 0) | (purpose === 'collection' ? FLAGS.collection : 0)
  const id = /^\d{1,15}$/.test(String(publicId)) ? Number(publicId) : String(publicId)
  return [id, encode(GAMES, game), encode(LANGUAGES, language), encode(CONDITIONS, condition), encode(PRINTINGS, printing) ?? printing, quantity, Math.round(price * 100), flags]
}
