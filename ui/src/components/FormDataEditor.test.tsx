import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FormDataEditor } from './FormDataEditor'
import { makeT } from '../lib/i18n'
import { fileFor, rememberFile } from '../lib/uploads'
import type { FormField } from '../lib/types'

const t = makeT('zh')

function makeFile(size = 2048, name = 'avatar.png', type = 'image/png') {
  return new File([new Uint8Array(size)], name, { type })
}

/**
 * Renders the editor as its callers use it — a controlled list — so a sequence
 * of edits behaves the way it does in the workbench, and reports every change.
 */
function setup(initial: FormField[]) {
  const onChange = vi.fn()
  function Harness() {
    const [rows, setRows] = useState(initial)
    return (
      <FormDataEditor
        t={t}
        rows={rows}
        onChange={next => {
          onChange(next)
          setRows(next)
        }}
      />
    )
  }
  render(<Harness />)
  return { onChange, rows: () => onChange.mock.lastCall?.[0] as FormField[] }
}

/**
 * The hidden input a row's pick button opens. It is deliberately out of the
 * accessibility tree, so it is reached by type rather than by role.
 */
function picker() {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

/** Picks files for the row whose picker is the given input. */
function pickFiles(files: File[], input: HTMLInputElement = picker()) {
  fireEvent.change(input, { target: { files } })
}

/**
 * Drops files onto a target. jsdom has no DataTransfer, so the event carries a
 * minimal stand-in with just the two properties the handler reads.
 */
function dropFiles(target: HTMLElement, files: File[]) {
  fireEvent.drop(target, { dataTransfer: { types: ['Files'], files } })
}

describe('FormDataEditor', () => {
  it('edits a text row in place', async () => {
    const { rows } = setup([{ key: 'name', value: '', kind: 'text' }])
    await userEvent.type(screen.getByLabelText('值'), '张三')
    expect(rows()).toEqual([{ key: 'name', value: '张三', kind: 'text' }])
  })

  it('swaps the value input for a picker when the row becomes a file', async () => {
    const { rows } = setup([{ key: 'avatar', value: 'x', kind: 'text' }])
    await userEvent.selectOptions(screen.getByLabelText('类型'), '文件')
    expect(rows()).toEqual([{ key: 'avatar', kind: 'file', file: undefined }])
    expect(screen.queryByLabelText('值')).not.toBeInTheDocument()
  })

  it('records a picked file under the row it was chosen for', () => {
    const { rows } = setup([{ key: 'avatar', kind: 'file' }])
    pickFiles([makeFile(2048, 'avatar.png')])

    const field = rows()[0]
    expect(field.kind).toBe('file')
    expect(field.files).toHaveLength(1)
    expect(field.files?.[0].name).toBe('avatar.png')
    expect(field.files?.[0].contentType).toBe('image/png')
    expect(field.files?.[0].size).toBe(2048)
    // The bytes are held out of the spec, behind a token.
    expect(fileFor(field.files?.[0].token)?.name).toBe('avatar.png')
  })

  it('attributes a pick to its own row, not to whichever was clicked last', () => {
    const { rows } = setup([
      { key: 'first', kind: 'file' },
      { key: 'second', kind: 'file' },
    ])
    const inputs = document.querySelectorAll('input[type="file"]')
    expect(inputs).toHaveLength(2)
    // Pick into the second row's input without touching any button.
    pickFiles([makeFile(8, 'second.png')], inputs[1] as HTMLInputElement)

    expect(rows()[0].files).toBeUndefined()
    expect(rows()[1].files?.[0].name).toBe('second.png')
  })

  it('accepts a dropped file, the route that survives a blocked picker', () => {
    const { rows } = setup([{ key: 'avatar', kind: 'file' }])
    dropFiles(screen.getByRole('button', { name: '选择文件' }), [makeFile(512, 'dropped.png')])

    const field = rows()[0]
    expect(field.files?.[0].name).toBe('dropped.png')
    expect(fileFor(field.files?.[0].token)?.name).toBe('dropped.png')
  })

  it('adds to the files a row already holds rather than replacing them', () => {
    const first = rememberFile(makeFile(16, 'first.png'))
    const { rows } = setup([
      { key: 'avatar', kind: 'file', files: [{ token: first, name: 'first.png', size: 16 }] },
    ])
    dropFiles(screen.getByText('first.png'), [makeFile(32, 'second.png')])

    expect(rows()[0].files?.map(f => f.name)).toEqual(['first.png', 'second.png'])
    // The first file is still there to be sent.
    expect(fileFor(first)?.name).toBe('first.png')
  })

  it('ignores a drag that carries no file', () => {
    const { rows } = setup([{ key: 'avatar', kind: 'file' }])
    const target = screen.getByRole('button', { name: '选择文件' })
    fireEvent.drop(target, { dataTransfer: { types: ['text/plain'], files: [] } })
    expect(rows()).toBeUndefined()
  })

  it('keeps several files in the one row that was picked for', () => {
    const { rows } = setup([{ key: 'file', kind: 'file' }])
    pickFiles([
      makeFile(10, 'a.xlsx', 'application/vnd.ms-excel'),
      makeFile(20, 'b.xlsx', 'application/vnd.ms-excel'),
      makeFile(30, 'c.xlsx', 'application/vnd.ms-excel'),
    ])

    const out = rows()
    // One field, three files: the field name is not duplicated into extra rows.
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('file')
    expect(out[0].kind).toBe('file')
    expect(out[0].files?.map(f => f.name)).toEqual(['a.xlsx', 'b.xlsx', 'c.xlsx'])
    expect(out[0].files?.map(f => f.size)).toEqual([10, 20, 30])
    for (const file of out[0].files ?? []) {
      expect(fileFor(file.token)?.name).toBe(file.name)
    }
  })

  it('appends when more files are picked later', () => {
    const { rows } = setup([{ key: 'file', kind: 'file' }])
    pickFiles([makeFile(10, 'a.bin')])
    pickFiles([makeFile(20, 'b.bin')], picker())
    expect(rows()[0].files?.map(f => f.name)).toEqual(['a.bin', 'b.bin'])
  })

  it('appends a drop carrying several files the same way', () => {
    const { rows } = setup([{ key: 'file', kind: 'file' }])
    dropFiles(screen.getByRole('button', { name: '选择文件' }), [
      makeFile(10, 'a.bin'),
      makeFile(20, 'b.bin'),
    ])
    expect(rows()).toHaveLength(1)
    expect(rows()[0].files?.map(f => f.name)).toEqual(['a.bin', 'b.bin'])
  })

  it('leaves the rows around a multi-file row alone', () => {
    const { rows } = setup([
      { key: 'before', value: '1', kind: 'text' },
      { key: 'file', kind: 'file' },
      { key: 'after', value: '2', kind: 'text' },
    ])
    const inputs = document.querySelectorAll('input[type="file"]')
    pickFiles([makeFile(10, 'a.bin'), makeFile(20, 'b.bin')], inputs[0] as HTMLInputElement)

    expect(rows().map(row => row.key)).toEqual(['before', 'file', 'after'])
  })

  it('removes one file from a row and keeps the rest', async () => {
    const { rows } = setup([{ key: 'file', kind: 'file' }])
    pickFiles([makeFile(10, 'a.bin'), makeFile(20, 'b.bin'), makeFile(30, 'c.bin')])
    await userEvent.click(screen.getAllByRole('button', { name: '移除文件' })[1])

    expect(rows()[0].files?.map(f => f.name)).toEqual(['a.bin', 'c.bin'])
  })

  it('forgets a file it removed, so a later send cannot pick it up', async () => {
    const { rows } = setup([{ key: 'file', kind: 'file' }])
    pickFiles([makeFile(10, 'a.bin'), makeFile(20, 'b.bin')])
    const token = rows()[0].files?.[0].token
    await userEvent.click(screen.getAllByRole('button', { name: '移除文件' })[0])
    expect(fileFor(token)).toBeUndefined()
  })

  it('shows how many files a row holds and their total size', () => {
    setup([{ key: 'file', kind: 'file' }])
    pickFiles([makeFile(1024, 'a.bin'), makeFile(2048, 'b.bin')])
    expect(screen.getByText('共 2 个文件 · 3.0 KB')).toBeInTheDocument()
  })

  it('keeps the field name and enabled switch on a multi-file row', () => {
    const { rows } = setup([{ key: 'files', kind: 'file', enabled: false }])
    pickFiles([makeFile(10, 'a.bin'), makeFile(20, 'b.bin')])

    const out = rows()
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('files')
    expect(out[0].enabled).toBe(false)
  })

  it('shows a lone file with its size, and removes it on request', async () => {
    const token = rememberFile(makeFile(2048, 'avatar.png'))
    const { rows } = setup([
      { key: 'avatar', kind: 'file', files: [{ token, name: 'avatar.png', size: 2048 }] },
    ])
    expect(screen.getByText('avatar.png')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '移除文件' }))
    expect(rows()).toEqual([{ key: 'avatar', kind: 'file', files: [] }])
    // Removing forgets the file, so a later send cannot pick it up again.
    expect(fileFor(token)).toBeUndefined()
  })

  it('marks a path-backed row as coming from a path', () => {
    setup([{ key: 'f', kind: 'file', files: [{ path: '/tmp/a.png' }] }])
    expect(screen.getByText('/tmp/a.png')).toBeInTheDocument()
    expect(screen.getByText('来自路径')).toBeInTheDocument()
  })

  it('says a saved file must be picked again rather than looking ready to send', () => {
    // What a reopened collection leaves behind: names but no bytes.
    setup([{ key: 'f', kind: 'file', files: [{ name: 'avatar.png' }, { name: 'b.png' }] }])
    expect(screen.getByText('avatar.png')).toBeInTheDocument()
    expect(screen.getByText('b.png')).toBeInTheDocument()
    expect(screen.getAllByText('需重新选择')).toHaveLength(2)
  })

  it('treats a row with no kind as text, the way a legacy save does', () => {
    setup([{ key: 'legacy', value: '@already' }])
    expect(screen.getByLabelText('值')).toHaveValue('@already')
  })

  it('adds and removes rows', async () => {
    const { rows } = setup([{ key: 'a', value: '1', kind: 'text' }])
    await userEvent.click(screen.getByRole('button', { name: /添加一行/ }))
    expect(rows()).toEqual([
      { key: 'a', value: '1', kind: 'text' },
      { key: '', value: '', enabled: true, kind: 'text' },
    ])

    await userEvent.click(screen.getAllByRole('button', { name: '移除该行' })[0])
    expect(rows()).toEqual([{ key: '', value: '', enabled: true, kind: 'text' }])
  })

  it('carries the enabled switch through', async () => {
    const { rows } = setup([{ key: 'a', value: '1', kind: 'text' }])
    await userEvent.click(screen.getByRole('checkbox', { name: '启用/停用该行' }))
    expect(rows()).toEqual([{ key: 'a', value: '1', kind: 'text', enabled: false }])
  })
})

// The urlencoded table is the same component with files switched off, so a body
// can move between the two encodings without a file row being flattened away.
describe('FormDataEditor without files', () => {
  function setupTextOnly(initial: FormField[]) {
    const onChange = vi.fn()
    function Harness() {
      const [rows, setRows] = useState(initial)
      return (
        <FormDataEditor
          t={t}
          rows={rows}
          allowFiles={false}
          onChange={next => {
            onChange(next)
            setRows(next)
          }}
        />
      )
    }
    render(<Harness />)
    return { rows: () => onChange.mock.lastCall?.[0] as FormField[] }
  }

  it('offers no type column', () => {
    setupTextOnly([{ key: 'a', value: '1', kind: 'text' }])
    expect(screen.queryByLabelText('类型')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '选择文件' })).not.toBeInTheDocument()
  })

  it('keeps the files a row already holds when a text value is edited', async () => {
    const token = rememberFile(makeFile(8, 'kept.xlsx'))
    const { rows } = setupTextOnly([
      { key: 'file', kind: 'file', files: [{ token, name: 'kept.xlsx', size: 8 }] },
    ])
    await userEvent.type(screen.getByLabelText('值'), 'x')

    const out = rows()
    expect(out[0].value).toBe('x')
    // The bytes are still attached, so switching back to form-data finds them.
    expect(out[0].files?.[0].token).toBe(token)
    expect(out[0].kind).toBe('file')
    expect(fileFor(token)?.name).toBe('kept.xlsx')
  })

  it('says which files this encoding will not send', () => {
    setupTextOnly([
      { key: 'file', kind: 'file', files: [{ path: '/tmp/a.xlsx' }, { name: 'b.xlsx' }] },
    ])
    // Once on the row, once in the banner over the table.
    expect(screen.getByText('2 个文件不会发送')).toBeInTheDocument()
    expect(screen.getByText(/此编码无法携带文件/)).toBeInTheDocument()
  })

  it('says nothing when no row holds a file', () => {
    setupTextOnly([{ key: 'a', value: '1', kind: 'text' }])
    expect(screen.queryByText(/此编码无法携带文件/)).not.toBeInTheDocument()
  })
})
