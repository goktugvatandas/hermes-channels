/**
 * Bot Mode's geometric bot faces, ported verbatim (same 40×40 geometry, eye
 * tables, colors, and name-hash defaults) so a bot looks identical in the
 * BOTS pane and everywhere in Channels. Shapes render live with idle blinks;
 * `shapeAvatarDataUrl` freezes one into an SVG data URL for persistence
 * (which is also how a shape picked here appears in Bot Mode — as an image).
 */

import { useEffect, useState } from 'react'

import { readBotModeMeta } from '../bot-mode-bridge'

export const AVATAR_SHAPES = [
  'circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop',
  'tetrahedron', 'cube', 'octahedron', 'dodecahedron', 'icosahedron',
] as const

export const AVATAR_COLORS = [
  '#f5f5f4', '#8d6748', '#ef4444', '#f97316', '#14b8a6',
  '#38bdf8', '#3b40c8', '#8b5cf6', '#ec4899', '#9ca3af',
]

const SIZE_PX = { sm: 28, md: 32, lg: 44 } as const

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

/** Bot Mode's default shape: name-hashed over the legacy seven. */
export function defaultShapeFor(name: string): string {
  return AVATAR_SHAPES[hashString(name) % 7]
}

/** Bot Mode's default color (host profileColor): stable hue, neutral default. */
export function defaultColorFor(name: string): string {
  const key = (name ?? '').trim()
  if (!key || key === 'default') return '#9ca3af'
  return `hsl(${hashString(key) % 360} 68% 58%)`
}

function isDarkColor(value: string): boolean {
  try {
    if (value.startsWith('#')) {
      const hex = value.length === 4
        ? value.slice(1).split('').map((c) => c + c).join('')
        : value.slice(1, 7)
      const n = parseInt(hex, 16)
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 110
    }
    const lightness = /(\d+(?:\.\d+)?)%\)/.exec(value)?.[1]
    return lightness !== undefined && Number(lightness) < 45
  } catch {
    return false
  }
}

const EYE_Y: Record<string, number> = {
  tetrahedron: 26, cube: 22.5, octahedron: 14.5, dodecahedron: 20, icosahedron: 17.5,
  circle: 17, squircle: 17, pill: 20, triangle: 25, hexagon: 17, cloud: 22, drop: 24,
}

const EYE_X: Record<string, [number, number]> = {
  tetrahedron: [16.5, 23.5], cube: [15, 25], octahedron: [16, 24],
  dodecahedron: [16.5, 23.5], icosahedron: [16.5, 23.5],
}

interface BodyPart {
  d?: string
  rect?: { x: number; y: number; width: number; height: number; rx: number }
  kind: 'circle' | 'edge' | 'face' | 'fill' | 'rect' | 'stroke'
}

/** The body geometry, straight from Bot Mode's shapeNode. */
const BODIES: Record<string, BodyPart[]> = {
  circle: [{ kind: 'circle' }],
  squircle: [{ kind: 'rect', rect: { x: 3, y: 3, width: 34, height: 34, rx: 11 } }],
  pill: [{ kind: 'rect', rect: { x: 2, y: 7, width: 36, height: 26, rx: 13 } }],
  triangle: [{ kind: 'stroke', d: 'M20 5.5 L36 33.5 L4 33.5 Z' }],
  hexagon: [{ kind: 'stroke', d: 'M20 3.5 L34.5 11.75 L34.5 28.25 L20 36.5 L5.5 28.25 L5.5 11.75 Z' }],
  cloud: [{ kind: 'fill', d: 'M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z' }],
  drop: [{ kind: 'fill', d: 'M20 3 C20 3 6 20 6 27 a14 13.5 0 0 0 28 0 C34 20 20 3 20 3 Z' }],
  tetrahedron: [
    { kind: 'face', d: 'M20 5 L36 33 L4 33 Z' },
    { kind: 'edge', d: 'M20 5 L20 25 M4 33 L20 25 M36 33 L20 25' },
  ],
  cube: [
    { kind: 'face', d: 'M20 4 L33 11 L33 29 L20 36 L7 29 L7 11 Z' },
    { kind: 'edge', d: 'M7 11 L20 18 L33 11 M20 18 L20 36' },
  ],
  octahedron: [
    { kind: 'face', d: 'M20 3 L36 20 L20 37 L4 20 Z' },
    { kind: 'edge', d: 'M4 20 L36 20 M20 3 L20 37' },
  ],
  dodecahedron: [
    { kind: 'face', d: 'M20 3 L30 6.2 L36.2 14.7 L36.2 25.3 L30 33.8 L20 37 L10 33.8 L3.8 25.3 L3.8 14.7 L10 6.2 Z' },
    { kind: 'edge', d: 'M20 12 L27.6 17.5 L24.7 26.5 L15.3 26.5 L12.4 17.5 Z M20 12 L20 3 M27.6 17.5 L36.2 14.7 M24.7 26.5 L30 33.8 M15.3 26.5 L10 33.8 M12.4 17.5 L3.8 14.7' },
  ],
  icosahedron: [
    { kind: 'face', d: 'M20 3 L34.7 11.5 L34.7 28.5 L20 37 L5.3 28.5 L5.3 11.5 Z' },
    { kind: 'edge', d: 'M20 11 L27.8 24.5 L12.2 24.5 Z M20 11 L20 3 M20 11 L34.7 11.5 M20 11 L5.3 11.5 M27.8 24.5 L34.7 11.5 M27.8 24.5 L34.7 28.5 M27.8 24.5 L20 37 M12.2 24.5 L5.3 11.5 M12.2 24.5 L5.3 28.5 M12.2 24.5 L20 37' },
  ],
}

function partAttrs(part: BodyPart, color: string): Record<string, unknown> {
  switch (part.kind) {
    case 'circle':
      return { cx: 20, cy: 20, r: 17.5, fill: color }
    case 'rect':
      return { ...part.rect, fill: color }
    case 'stroke':
      return { d: part.d, fill: color, stroke: color, strokeWidth: 7, strokeLinejoin: 'round' }
    case 'face':
      return { d: part.d, fill: color, stroke: 'rgba(0,0,0,0.4)', strokeWidth: 1.4, strokeLinejoin: 'round' }
    case 'edge':
      return { d: part.d, fill: 'none', stroke: 'rgba(0,0,0,0.4)', strokeWidth: 1.4, strokeLinejoin: 'round', strokeLinecap: 'round' }
    default:
      return { d: part.d, fill: color }
  }
}

function Body({ shape, color }: { shape: string; color: string }) {
  const parts = BODIES[shape] ?? BODIES.circle
  return (
    <g>
      {parts.map((part, index) => (
        part.kind === 'circle'
          ? <circle key={index} {...partAttrs(part, color)} />
          : part.kind === 'rect'
            ? <rect key={index} {...partAttrs(part, color)} />
            : <path key={index} {...partAttrs(part, color)} />
      ))}
    </g>
  )
}

/** A live bot face: Bot Mode geometry plus its idle blink. */
export function ShapeFace({ shape, color, size = 32 }: { shape: string; color: string; size?: number }) {
  const [blink, setBlink] = useState(false)

  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | null = null
    let openTimer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      closeTimer = setTimeout(() => {
        setBlink(true)
        openTimer = setTimeout(() => {
          setBlink(false)
          schedule()
        }, 120)
      }, 3000 + Math.random() * 4000)
    }
    schedule()
    return () => {
      if (closeTimer) clearTimeout(closeTimer)
      if (openTimer) clearTimeout(openTimer)
    }
  }, [])

  const eyeY = EYE_Y[shape] ?? 17
  const [eyeL, eyeR] = EYE_X[shape] ?? [15.5, 24.5]
  const eyeFill = isDarkColor(color) ? 'rgba(232,220,195,0.95)' : 'rgba(0,0,0,0.85)'

  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 40 40" width={size}>
      <Body color={color} shape={shape} />
      {blink ? (
        <path
          d={`M${eyeL - 2.2} ${eyeY} L${eyeL + 2.2} ${eyeY} M${eyeR - 2.2} ${eyeY} L${eyeR + 2.2} ${eyeY}`}
          fill="none"
          stroke={eyeFill}
          strokeLinecap="round"
          strokeWidth={1.8}
        />
      ) : (
        <g>
          <circle cx={eyeL} cy={eyeY} fill={eyeFill} r={2.4} />
          <circle cx={eyeR} cy={eyeY} fill={eyeFill} r={2.4} />
        </g>
      )}
    </svg>
  )
}

function partMarkup(part: BodyPart, color: string): string {
  const attrs = partAttrs(part, color)
  const tag = part.kind === 'circle' ? 'circle' : part.kind === 'rect' ? 'rect' : 'path'
  const rendered = Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`)
    .join(' ')
  return `<${tag} ${rendered}/>`
}

/** Freeze a shape face (eyes open) into an SVG data URL for persistence. */
export function shapeAvatarDataUrl(shape: string, color: string): string {
  const parts = (BODIES[shape] ?? BODIES.circle).map((part) => partMarkup(part, color)).join('')
  const eyeY = EYE_Y[shape] ?? 17
  const [eyeL, eyeR] = EYE_X[shape] ?? [15.5, 24.5]
  const eyeFill = isDarkColor(color) ? 'rgba(232,220,195,0.95)' : 'rgba(0,0,0,0.85)'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${parts}` +
    `<circle cx="${eyeL}" cy="${eyeY}" r="2.4" fill="${eyeFill}"/>` +
    `<circle cx="${eyeR}" cy="${eyeY}" r="2.4" fill="${eyeFill}"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * The one bot-avatar renderer: stored image wins; otherwise the Bot Mode
 * shape face — appearance from Bot Mode's meta when present, else the same
 * name-hash defaults Bot Mode uses, so both rosters always agree.
 */
export function BotAvatar({ profileId, name, avatar, color, size = 'md' }: {
  profileId: string
  name?: string
  avatar?: string | null
  color?: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const px = SIZE_PX[size]
  const label = name || profileId
  if (avatar) {
    return (
      <span aria-label={label} className="grid shrink-0 place-items-center overflow-hidden rounded-full" role="img" style={{ width: px, height: px }}>
        <img alt="" aria-hidden="true" src={avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    )
  }
  const meta = readBotModeMeta(profileId)
  const shape = meta.shape || defaultShapeFor(profileId)
  const shapeColor = color || meta.color || defaultColorFor(profileId)
  return (
    <span aria-label={label} className="grid shrink-0 place-items-center" role="img" style={{ width: px, height: px }}>
      <ShapeFace color={shapeColor} shape={shape} size={px} />
    </span>
  )
}
