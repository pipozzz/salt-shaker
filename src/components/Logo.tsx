export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-accent-600" />
      <path d="M11 9h10l-1 3H12zM10 13h12l-1.5 11a2 2 0 0 1-2 1.7h-5a2 2 0 0 1-2-1.7z" fill="#fff" />
      <circle cx="14" cy="6.5" r="1" fill="#fff" />
      <circle cx="18" cy="6.5" r="1" fill="#fff" />
      <circle cx="16" cy="4" r="1" fill="#fff" />
    </svg>
  )
}
