import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

const options = [
  { value: 'get', label: 'GET' },
  { value: 'post', label: 'POST' },
]

/** jsdom does no layout, so the trigger reports the box it would occupy. */
function stubTrigger(rect: { top: number; bottom: number; left: number; width: number }) {
  const trigger = screen.getByRole('button', { name: '方法' })
  trigger.getBoundingClientRect = () =>
    ({
      ...rect,
      height: rect.bottom - rect.top,
      right: rect.left + rect.width,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect
  return trigger
}

const list = () => screen.getByRole('listbox')

describe('the dropdown', () => {
  it('shows the current value on the trigger and opens the list on click', async () => {
    render(<Select value="get" options={options} onChange={() => {}} aria-label="方法" />)
    expect(screen.getByRole('button', { name: '方法' })).toHaveTextContent('GET')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    const list = screen.getByRole('listbox')
    expect(list).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('ticks the chosen option and hands the pick back', async () => {
    const onChange = vi.fn()
    render(<Select value="get" options={options} onChange={onChange} aria-label="方法" />)
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    const [first, second] = screen.getAllByRole('option')
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(first.querySelector('svg')).toBeTruthy()
    expect(second.querySelector('svg')).toBeNull()
    await userEvent.click(second)
    expect(onChange).toHaveBeenCalledWith('post')
    // Picking closes the list again.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes on Escape without picking anything', async () => {
    const onChange = vi.fn()
    render(<Select value="get" options={options} onChange={onChange} aria-label="方法" />)
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes when the click lands outside', async () => {
    render(<Select value="get" options={options} onChange={() => {}} aria-label="方法" />)
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    await userEvent.click(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('anchors the open list to the trigger, below it by default', async () => {
    render(<Select value="get" options={options} onChange={() => {}} aria-label="方法" />)
    // Room below the trigger for the whole list.
    stubTrigger({ top: 100, bottom: 130, left: 40, width: 108 })
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    const pop = list()
    expect(pop.style.left).toBe('40px')
    expect(pop.style.width).toBe('108px')
    // Below the trigger: anchored by its top edge, 4px clear of the trigger.
    expect(pop.style.top).toBe('134px')
    expect(pop.style.bottom).toBe('auto')
  })

  it('flips the list above a trigger that sits near the bottom edge', async () => {
    // The window is 768 tall by default in jsdom; a trigger 20px from the
    // bottom has no room below, so the list hangs off its top edge instead.
    render(<Select value="get" options={options} onChange={() => {}} aria-label="方法" />)
    stubTrigger({ top: 718, bottom: 748, left: 40, width: 108 })
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    const pop = list()
    expect(pop.style.bottom).toBe('54px')
    expect(pop.style.top).toBe('auto')
    // Plenty of room above, so the list keeps its own maximum.
    expect(Number.parseFloat(pop.style.maxHeight)).toBe(280)
  })

  it('caps the list to the room it actually has', async () => {
    // Room below the trigger (200px) is real but shorter than the list's own
    // maximum, so the list shortens to fit rather than running off the bottom.
    render(<Select value="get" options={options} onChange={() => {}} aria-label="方法" />)
    stubTrigger({ top: 526, bottom: 556, left: 40, width: 108 })
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    const pop = list()
    expect(pop.style.top).toBe('560px')
    expect(Number.parseFloat(pop.style.maxHeight)).toBe(200)
  })

  it('follows its trigger while the page scrolls under it', async () => {
    render(<Select value="get" options={options} onChange={() => {}} aria-label="方法" />)
    stubTrigger({ top: 100, bottom: 130, left: 40, width: 108 })
    await userEvent.click(screen.getByRole('button', { name: '方法' }))
    expect(list().style.top).toBe('134px')
    // The pane scrolls: the trigger moves, the list must move with it.
    stubTrigger({ top: 60, bottom: 90, left: 40, width: 108 })
    fireEvent.scroll(document.querySelector('.req-body') ?? document)
    expect(list().style.top).toBe('94px')
  })
})
