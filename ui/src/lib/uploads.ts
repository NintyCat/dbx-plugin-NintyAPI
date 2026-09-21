import type { T } from './i18n'
import type { BodySpec, FileRef, FormField, RequestSpec } from './types'

/**
 * Files picked in the workbench, and the chunked upload that gets them to the
 * sidecar.
 *
 * Two facts shape everything here. The workbench UI runs in a sandboxed iframe,
 * so a picked File is a browser object with no path on disk — the sidecar, a
 * separate process, cannot open it. And the host bridge caps one JSON parameter
 * at 2 MiB, so the bytes cannot simply ride along with the request either. The
 * file is therefore cut into chunks that fit the bridge, reassembled on disk by
 * the sidecar, and named by the request that sends it.
 */

/** Bytes per chunk. Base64 inflates by a third, leaving ample room under 2 MiB. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024

/**
 * The picked files this session knows about, keyed by the token a spec row
 * carries. Deliberately module state rather than React state: the File objects
 * are large, nothing renders them directly, and a tab that is closed should not
 * take the only reference with it.
 */
const picked = new Map<string, File>()

let tokenSeq = 0

/** Registers a picked file and returns the token that names it. */
export function rememberFile(file: File): string {
  const token = `f${++tokenSeq}-${Date.now().toString(36)}`
  picked.set(token, file)
  return token
}

/** The file behind a token, or undefined once the page has been reloaded. */
export function fileFor(token?: string): File | undefined {
  return token ? picked.get(token) : undefined
}

/** Drops a file the user cleared, so it cannot be sent by a later request. */
export function forgetFile(token?: string): void {
  if (token) picked.delete(token)
}

/**
 * A FileRef as the editor shows it: a picked file's name and size, or the path
 * a cURL import wrote down.
 */
export function describeFile(ref?: FileRef): string {
  if (!ref) return ''
  if (ref.name) return ref.name
  return ref.path || ''
}

/** The size of the file a row will send, when it is known. */
export function fileSizeOf(ref?: FileRef): number | undefined {
  if (!ref) return undefined
  return fileFor(ref.token)?.size ?? ref.size
}

/**
 * True when a ref names bytes this session can still reach: a picked file, or a
 * path the sidecar can open. A ref that kept only a name — what a reopened
 * collection leaves behind — is displayable but not sendable.
 */
function hasFileSource(ref: FileRef): boolean {
  return Boolean(ref.id || ref.path || ref.token)
}

/**
 * True when a row is a file row, whether or not it has files yet. Such a row
 * with nothing attached contributes nothing at all — never an empty field,
 * which a server would read as a successful upload of zero bytes.
 */
export function isFileRow(field: FormField): boolean {
  return field.kind === 'file' || field.file !== undefined || field.files !== undefined
}

/**
 * The files a form row carries, in order, for display.
 *
 * Every shape a row can arrive in is folded here so the editor only ever sees a
 * list: the current `files` array, the single `file` object saved before a row
 * could hold several, and a cURL import's "@path" written into the value. A ref
 * with nothing left but a name is kept, so a reopened row still says which file
 * it was instead of looking untouched. The sidecar folds the same shapes on its
 * side, for the same reason.
 */
export function rowFiles(field: FormField): FileRef[] {
  if (field.kind === 'text') return []
  const named = (ref: FileRef) => hasFileSource(ref) || Boolean(ref.name)
  const files = (field.files || []).filter(named)
  if (files.length > 0) return files
  if (field.file && named(field.file)) return [field.file]
  if (field.kind === 'file') return []
  const value = field.value?.trim() ?? ''
  if (value.startsWith('@') && value.length > 1) return [{ path: value.slice(1) }]
  return []
}

/** Total size of a row's files, counting only the ones whose size is known. */
export function rowSizeOf(files: FileRef[]): number | undefined {
  const sizes = files.map(fileSizeOf).filter((size): size is number => size !== undefined)
  return sizes.length > 0 ? sizes.reduce((sum, size) => sum + size, 0) : undefined
}

export type InvokeFn = <R>(method: string, params?: Record<string, unknown>) => Promise<R>

/**
 * Streams one file to the sidecar and returns the reference the request uses.
 *
 * The upload is abandoned on any failure, so a chunk that never lands does not
 * leave a half-written file behind for the sidecar to time out on.
 */
export async function uploadFile(
  file: File,
  invoke: InvokeFn,
  onProgress?: (sent: number, total: number) => void
): Promise<FileRef> {
  const contentType = file.type || 'application/octet-stream'
  const { uploadId } = await invoke<{ uploadId: string }>('upload/begin', {
    name: file.name,
    contentType,
    size: file.size,
  })
  try {
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      const slice = file.slice(offset, offset + UPLOAD_CHUNK_BYTES)
      const data = base64Of(await slice.arrayBuffer())
      await invoke('upload/chunk', { uploadId, offset, data })
      onProgress?.(Math.min(offset + slice.size, file.size), file.size)
    }
    return { id: uploadId, name: file.name, contentType, size: file.size }
  } catch (error) {
    // Best effort: the sidecar sweeps abandoned uploads anyway, and the original
    // failure is what the user needs to see.
    void invoke('upload/abort', { uploadId }).catch(() => undefined)
    throw error
  }
}

/**
 * Base64 in sub-chunks: spreading a whole chunk into String.fromCharCode would
 * push half a million arguments onto the stack and overflow it.
 */
function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

export type UploadProgress = { sent: number; total: number }

/**
 * Rewrites a request so every file it carries points at bytes the sidecar can
 * already read: picked files are uploaded and their rows replaced with the
 * upload's id, and the UI-only tokens are stripped.
 *
 * A file row with neither a picked file nor a path is an error rather than a
 * silently empty part — a saved request reopened in a new session has the
 * filename but no bytes, and sending it would look like it worked.
 */
export async function resolveRequestFiles(
  spec: RequestSpec,
  invoke: InvokeFn,
  t: T,
  onProgress?: (progress: UploadProgress) => void
): Promise<RequestSpec> {
  const body = spec.body
  if (!body) return spec

  const totals = collectUploads(body)
  // Announce the upload before the first chunk, so the workbench can show that
  // bytes are moving instead of looking like a request already in flight.
  if (totals > 0) onProgress?.({ sent: 0, total: totals })
  let done = 0
  const track = async (file: File): Promise<FileRef> => {
    const ref = await uploadFile(file, invoke, sent => {
      onProgress?.({ sent: done + sent, total: totals })
    })
    done += file.size
    return ref
  }

  if (body.type === 'multipart') {
    const fields: FormField[] = []
    for (const field of body.fields || []) {
      fields.push(await resolveField(field, track, t))
    }
    return { ...spec, body: { ...body, fields } }
  }

  if (body.type === 'form') {
    // urlencoded has nowhere to put a file, and the rows keep theirs so the
    // encoding can be switched back. Failing here means nothing is uploaded for
    // a request that could never have sent it — the sidecar refuses the same
    // combination, this just says so sooner.
    const carrying = (body.fields || []).find(
      field => field.enabled !== false && rowFiles(field).length > 0
    )
    if (carrying) {
      throw new Error(t('formCannotCarryFiles', { name: carrying.key || '?' }))
    }
    return spec
  }

  if (body.type === 'binary' && body.file) {
    const file = fileFor(body.file.token)
    if (file) return { ...spec, body: { ...body, file: await track(file) } }
    const ref = withoutToken(body.file)
    if (!ref.path) throw new Error(t('binaryFileRequired'))
    return { ...spec, body: { ...body, file: ref } }
  }

  return spec
}

async function resolveField(
  field: FormField,
  track: (file: File) => Promise<FileRef>,
  t: T
): Promise<FormField> {
  // A disabled row is not sent, so it is not worth demanding files for.
  if (field.enabled === false) return field
  // A row that kept only filenames has nothing to send; failing here is what
  // keeps it from going out as an empty part.
  const sendable = rowFiles(field).filter(hasFileSource)
  if (sendable.length === 0) {
    if (isFileRow(field)) {
      throw new Error(t('formFileRequired', { name: field.key || '?' }))
    }
    return field
  }
  const files: FileRef[] = []
  for (const ref of sendable) {
    const file = fileFor(ref.token)
    files.push(file ? await track(file) : withoutToken(ref))
  }
  return { ...field, value: undefined, file: undefined, files }
}

/** A FileRef with the session-only token removed, ready for the wire. */
function withoutToken(ref?: FileRef): FileRef {
  if (!ref) return {}
  const { token: _token, id: _id, ...rest } = ref
  return rest
}

/** Total bytes the request's picked files will upload. */
function collectUploads(body: BodySpec): number {
  const refs = body.type === 'multipart'
    ? (body.fields || []).flatMap(rowFiles)
    : [body.file]
  return refs.reduce((sum, ref) => sum + (fileFor(ref?.token)?.size ?? 0), 0)
}

/**
 * A body with every picked file's token and stale upload id removed, for
 * storage. Collections and history outlive the session, so they keep what the
 * files were called but not a claim that their bytes are still reachable.
 */
export function stripFileTokens(body?: BodySpec): BodySpec | undefined {
  if (!body) return undefined
  // Fields are stripped whatever the form encoding: a body switched from
  // form-data to urlencoded still holds its files, and a token that outlives
  // the session it was minted in is worse than useless.
  if (body.fields) {
    return {
      ...body,
      fields: body.fields.map(field => {
        if (!field.files && !field.file) return field
        const files = (field.files || (field.file ? [field.file] : []))
          .map(withoutToken)
          // A file whose only information was the token keeps its name, so
          // reopening the row still shows what it was.
          .filter(file => file.path || file.name)
        return { ...field, file: undefined, files: files.length > 0 ? files : undefined }
      }),
    }
  }
  if (body.file) {
    const file = withoutToken(body.file)
    return { ...body, file: file.path || file.name ? file : undefined }
  }
  return body
}
