interface AvatarProps {
  name: string
  src?: string | null
  color?: string | null
  size?: 'sm' | 'md' | 'lg'
}

const SIZE_CLASSES = {
  sm: 'size-7 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-11 text-sm',
} as const

const IDENTITY_COLORS = [
  ['#e9e4f9', '#5b4a9e'],
  ['#def0e2', '#2f7d4a'],
  ['#fdeadb', '#b05c1d'],
  ['#dcedfb', '#22639e'],
  ['#fbe3e8', '#b03a54'],
  ['#dff0ed', '#1f7a6d'],
  ['#f6ecd4', '#8a6116'],
  ['#e8e8ee', '#4c4f5e'],
] as const

function identityColors(name: string): readonly [string, string] {
  let hash = 0
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length]
}

function initialsFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?'
}

export function Avatar({ name, src, color, size = 'md' }: AvatarProps) {
  const [background, foreground] = identityColors(name)
  return (
    <span
      aria-label={name}
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold ${SIZE_CLASSES[size]}`}
      style={src ? undefined : { backgroundColor: color || background, color: color ? '#fff' : foreground }}
    >
      {src ? <img alt="" className="size-full object-cover" src={src} /> : initialsFor(name)}
    </span>
  )
}
