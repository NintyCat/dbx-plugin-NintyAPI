type IconProps = {
  name: IconName
  size?: number
  className?: string
}

export type IconName =
  | 'api'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'search'
  | 'plus'
  | 'trash'
  | 'edit'
  | 'send'
  | 'globe'
  | 'clock'
  | 'copy'
  | 'save'
  | 'close'
  | 'code'
  | 'import'
  | 'format'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'download'
  | 'settings'
  | 'check'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'refresh'
  | 'close-others'
  | 'cut'
  | 'paste'
  | 'more'
  | 'pin'

const paths: Record<IconName, React.ReactNode> = {
  api: (
    <>
      <path d="M8 4c-2 0-2.5 1-2.5 2.5v1C5.5 9 4.8 10 3.5 10.5 4.8 11 5.5 12 5.5 13.5v1C5.5 16 6 17 8 17" />
      <path d="M16 4c2 0 2.5 1 2.5 2.5v1c0 1.5.7 2.5 2 3-1.3.5-2 1.5-2 3v1c0 1.5-.5 2.5-2.5 2.5" />
    </>
  ),
  folder: <path d="M3 6.5C3 5.7 3.7 5 4.5 5h3.6c.4 0 .8.2 1.1.5l1 1.1c.3.3.7.4 1.1.4h6.2c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C3.7 18 3 17.3 3 16.5v-10Z" />,
  // The same folder with its front flap swung open: the back panel stops
  // where the mouth is, and the flap slants down-left past it.
  'folder-open': (
    <>
      <path d="M3 13.5V6.5C3 5.7 3.7 5 4.5 5h3.6c.4 0 .8.2 1.1.5l1 1.1c.3.3.7.4 1.1.4h6.2c.8 0 1.5.7 1.5 1.5v2.9" />
      <path d="M18.5 10.5H8.6c-.5 0-1 .3-1.2.7L3.6 17.3c-.3.6.1 1.2.8 1.2h10.2c.6 0 1.1-.3 1.3-.9l2.6-6.2c.3-.6-.2-1.4-.9-1.4Z" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h6.5L17 8v10.5c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-14c0-.6.4-1 1-1Z" />
      <path d="M12.5 3.5V8H17" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.5 13.5 4 4" />
    </>
  ),
  plus: <path d="M10 4v12M4 10h12" />,
  trash: (
    <>
      <path d="M4 6h12M8 6V4.5c0-.6.4-1 1-1h2c.6 0 1 .4 1 1V6" />
      <path d="M6 6v9.5c0 .8.7 1.5 1.5 1.5h5c.8 0 1.5-.7 1.5-1.5V6" />
      <path d="M9 9.5v4M12 9.5v4" />
    </>
  ),
  edit: <path d="m4 16.5-.5 3 3-.5L17 8.5a1.4 1.4 0 0 0 0-2l-1.5-1.5a1.4 1.4 0 0 0-2 0L4 16.5Z" />,
  send: <path d="M4.5 10.8 16 5.2c.7-.4 1.5.4 1.2 1.1l-4.4 10.9c-.3.8-1.5.7-1.7-.1l-1-3.9-4-1c-.8-.2-.9-1.3-.6-1.4Z" />,
  globe: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 1.8 3 4.2 3 7s-1 5.2-3 7c-2-1.8-3-4.2-3-7s1-5.2 3-7Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.5l3 1.8" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" />
      <path d="M13.5 7V5c0-.8-.7-1.5-1.5-1.5H5C4.2 3.5 3.5 4.2 3.5 5v7c0 .8.7 1.5 1.5 1.5h2" />
    </>
  ),
  save: (
    <>
      <path d="M4 5c0-.6.4-1 1-1h8.6L17 7.4v8.6c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V5Z" />
      <path d="M6.5 4v4h7V4" />
      <path d="M6.5 17v-4c0-.6.4-1 1-1h5c.6 0 1 .4 1 1v4" />
    </>
  ),
  close: <path d="m5 5 10 10M15 5 5 15" />,
  download: <path d="M10 3.5v9m0 0 3.5-3.5M10 12.5 6.5 9M4 16.5h12" />,
  code: <path d="m7 7-4 3 4 3M13 7l4 3-4 3" />,
  import: <path d="M10 3v8m0 0 3-3m-3 3L7 8M4 13.5V15c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5v-1.5" />,
  format: <path d="M4 5h12M4 10h8M4 15h10" />,
  'chevron-right': <path d="m8 5 5 5-5 5" />,
  'chevron-down': <path d="m5 8 5 5 5-5" />,
  'chevron-up': <path d="m5 13 5-5 5 5" />,
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.3 5.3l1.4 1.4M13.3 13.3l1.4 1.4M14.7 5.3l-1.4 1.4M6.7 13.3l-1.4 1.4" />
    </>
  ),
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  sun: (
    <>
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
    </>
  ),
  moon: <path d="M16.5 12.5A7 7 0 0 1 7.5 3.5a7 7 0 1 0 9 9Z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="14" height="9.5" rx="1.5" />
      <path d="M7 16.5h6M10 13.5v3" />
    </>
  ),
  refresh: (
    <>
      <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" />
      <path d="M16.5 3.5V7H13" />
    </>
  ),
  'close-others': (
    <>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
      <path d="m11.5 11.5 5 5M16.5 11.5l-5 5" />
    </>
  ),
  cut: (
    <>
      <circle cx="5.5" cy="14.5" r="2.5" />
      <circle cx="14.5" cy="14.5" r="2.5" />
      <path d="M7.3 12.7 15 3M12.7 12.7 5 3" />
    </>
  ),
  paste: (
    <>
      <path d="M7.5 4.5H6c-.8 0-1.5.7-1.5 1.5v9c0 .8.7 1.5 1.5 1.5h8c.8 0 1.5-.7 1.5-1.5V6c0-.8-.7-1.5-1.5-1.5h-1.5" />
      <rect x="7.5" y="2.5" width="5" height="3.5" rx="1" />
    </>
  ),
  // Filled rather than stroked: three round dots, the way an overflow control
  // reads everywhere else.
  more: (
    <>
      <circle cx="4.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  // A thumbtack, tilted the way a pin usually reads.
  pin: (
    <>
      <path d="M7.5 3.5h5l-.7 3.2 2.4 2.1v1.4H5.8V8.8l2.4-2.1-.7-3.2Z" />
      <path d="M10 10.2v6.3" />
    </>
  ),
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}
