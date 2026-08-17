import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import { CardPrefixEditor } from '../../src/desktop/components/card-prefix-editor'
import type { CardPrefixConfiguration } from '../../src/desktop/types'

afterEach(cleanup)

const PREFIXES: CardPrefixConfiguration[] = [
  {
    boardSlug: 'channel-circle',
    boardName: 'Circle',
    prefix: 'CI',
    generatedPrefix: 'CI',
    customized: false,
    cardCount: 0,
  },
  {
    boardSlug: 'channel-seatech',
    boardName: 'SellerDoping',
    prefix: 'SD',
    generatedPrefix: 'SE',
    customized: true,
    cardCount: 3,
  },
]

function fixture() {
  const getCardPrefixes = vi.fn().mockResolvedValue(PREFIXES)
  const updateCardPrefix = vi.fn().mockImplementation(
    (boardSlug: string, prefix: string | null) => Promise.resolve({
      ...PREFIXES.find((item) => item.boardSlug === boardSlug)!,
      prefix: prefix || (boardSlug === 'channel-seatech' ? 'SE' : 'CI'),
      customized: prefix !== null,
      migratedCards: boardSlug === 'channel-seatech' ? 3 : 0,
    }),
  )
  return {
    api: { getCardPrefixes, updateCardPrefix } as unknown as CrewApi,
    getCardPrefixes,
    updateCardPrefix,
  }
}

describe('CardPrefixEditor', () => {
  it('shows automatic defaults and customized prefixes', async () => {
    const { api } = fixture()
    render(<CardPrefixEditor api={api} />)

    expect(await screen.findByRole('heading', { name: 'Card prefixes' })).toBeTruthy()
    expect(screen.getByText('Automatic: CI')).toBeTruthy()
    expect(screen.getByText('Automatic: SE')).toBeTruthy()
    expect((screen.getByLabelText('SellerDoping prefix') as HTMLInputElement).value).toBe('SD')
    expect(screen.getByText('3 existing cards will be renamed when this prefix changes.')).toBeTruthy()
  })

  it('uppercases and saves an edited prefix', async () => {
    const { api, updateCardPrefix } = fixture()
    render(<CardPrefixEditor api={api} />)
    const input = await screen.findByLabelText('SellerDoping prefix')

    fireEvent.change(input, { target: { value: 'sp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save SellerDoping prefix' }))

    await waitFor(() => expect(updateCardPrefix).toHaveBeenCalledWith('channel-seatech', 'SP'))
    expect(await screen.findByText('SellerDoping prefix saved. 3 cards updated.')).toBeTruthy()
  })

  it('can restore the generated default', async () => {
    const { api, updateCardPrefix } = fixture()
    render(<CardPrefixEditor api={api} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Use automatic prefix for SellerDoping' }))

    await waitFor(() => expect(updateCardPrefix).toHaveBeenCalledWith('channel-seatech', null))
  })

  it('rejects prefixes that do not start with a letter', async () => {
    const { api, updateCardPrefix } = fixture()
    render(<CardPrefixEditor api={api} />)
    const input = await screen.findByLabelText('SellerDoping prefix')

    fireEvent.change(input, { target: { value: '1x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save SellerDoping prefix' }))

    expect(updateCardPrefix).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Start with a letter')
  })
})
