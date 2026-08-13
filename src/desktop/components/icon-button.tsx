import type { ButtonHTMLAttributes } from 'react'

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  codicon: string
  label: string
}

export function IconButton({ codicon, label, className = '', type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      className={`grid size-[30px] shrink-0 place-items-center rounded hover:bg-(--ui-surface-secondary) ${className}`}
      type={type}
    >
      <span aria-hidden="true" className={`codicon codicon-${codicon}`} />
    </button>
  )
}
