import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@hermes/plugin-sdk'

export interface ThemedOption {
  value: string
  label: string
}

/**
 * The host's Radix Select with a compact trigger: themed popover instead of
 * the native <option> list, which renders in the OS color scheme and goes
 * unreadable over dark skins. Radix forbids empty item values, so callers
 * map sentinels for "none" choices.
 */
export function ThemedSelect({ value, options, onChange, ariaLabel, className }: {
  value: string
  options: ThemedOption[]
  onChange(value: string): void
  ariaLabel: string
  className?: string
}) {
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={className ?? 'h-7 rounded-md bg-(--ui-surface-secondary) px-2 py-1 text-xs font-medium text-foreground'}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
