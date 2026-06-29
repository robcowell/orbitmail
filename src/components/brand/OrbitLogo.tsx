interface OrbitLogoProps {
  size?: number
  className?: string
}

export function OrbitLogo({ size = 32, className }: OrbitLogoProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="orbit-logo-bg" x1="4" y1="2" x2="28" y2="30">
          <stop stopColor="#4f46e5" />
          <stop offset="0.55" stopColor="#6366f1" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="url(#orbit-logo-bg)" />
      <circle cx="16" cy="16" r="12.5" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="2.2" fill="none" />
      <path
        fill="#ffffff"
        d="M5.5 8.5c0-1.65 1.35-3 3-3h15c1.65 0 3 1.35 3 3v14.25c0 1.65-1.35 3-3 3h-15c-1.65 0-3-1.35-3-3V8.5zm3 2.25 6 4.8 6-4.8"
      />
    </svg>
  )
}
