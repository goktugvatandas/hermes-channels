import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Avatar } from '../../src/desktop/components/avatar'
import { IconButton } from '../../src/desktop/components/icon-button'
import { SaveStatus } from '../../src/desktop/components/save-status'

afterEach(cleanup)

describe('Crew UI primitives', () => {
  it('uses two initials when a profile has no avatar', () => {
    render(<Avatar color="#2563eb" name="Atlas Agent" />)

    expect(screen.getByLabelText('Atlas Agent').textContent).toBe('AA')
  })

  it('renders configured avatar images without duplicating the accessible name', () => {
    render(<Avatar name="Atlas" src="data:image/png;base64,avatar" />)

    const avatar = screen.getByLabelText('Atlas')
    expect(avatar.querySelector('img')?.getAttribute('alt')).toBe('')
  })

  it('gives compact icon actions an accessible name and button type', () => {
    render(<IconButton codicon="reply" label="Reply in thread" />)

    const button = screen.getByRole('button', { name: 'Reply in thread' }) as HTMLButtonElement
    expect(button.type).toBe('button')
    expect(button.className).toContain('size-[30px]')
  })

  it('announces save failures and stays silent while idle', () => {
    const { rerender } = render(<SaveStatus error={null} state="idle" />)
    expect(screen.queryByRole('status')).toBeNull()

    rerender(<SaveStatus error="Could not save role" state="error" />)
    expect(screen.getByRole('status').textContent).toContain("Couldn't save")
    expect(screen.getByRole('alert').textContent).toBe('Could not save role')
  })
})
