/**
 * Random agent names with a mythological flavor: half the time a name from
 * real mythologies, half the time an invented one built from myth-sounding
 * syllables so crews don't all converge on the same dozen gods.
 */

const MYTH_NAMES = [
  'Athena', 'Apollo', 'Artemis', 'Selene', 'Helios', 'Orion', 'Nyx', 'Iris',
  'Thoth', 'Isis', 'Horus', 'Anubis', 'Freya', 'Odin', 'Baldur', 'Sif',
  'Brigid', 'Morrigan', 'Taliesin', 'Rhiannon', 'Inanna', 'Enki', 'Tiamat',
  'Amaterasu', 'Susanoo', 'Izanami', 'Quetzal', 'Ixchel', 'Pele', 'Maui',
  'Vesta', 'Janus', 'Minerva', 'Juno', 'Fortuna', 'Aurora',
] as const

const ONSETS = [
  'Ael', 'Ast', 'Bel', 'Cal', 'Cyr', 'Elo', 'Era', 'Ith', 'Kor', 'Lyr',
  'Myr', 'Nym', 'Ophe', 'Or', 'Sel', 'Sol', 'Thal', 'Umb', 'Vael', 'Vesp',
  'Xan', 'Yll', 'Zeph',
] as const

const ENDINGS = [
  'a', 'ael', 'aia', 'anthe', 'ara', 'aris', 'eia', 'emis', 'eth', 'ia',
  'iel', 'ine', 'ion', 'ios', 'is', 'ith', 'ora', 'oros', 'os', 'yn', 'yra',
] as const

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export function generateMythicalName(current?: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = Math.random() < 0.5 ? pick(MYTH_NAMES) : `${pick(ONSETS)}${pick(ENDINGS)}`
    if (name !== current) return name
  }
  return pick(MYTH_NAMES)
}
