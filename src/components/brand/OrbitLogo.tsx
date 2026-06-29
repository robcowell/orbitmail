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
        <linearGradient id="orbit-gradient" x1="4" y1="4" x2="28" y2="28">
          <stop stopColor="#5b5fe8" />
          <stop offset="0.5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="14" stroke="url(#orbit-gradient)" strokeWidth="2" opacity="0.35" />
      <ellipse
        cx="16"
        cy="16"
        rx="11"
        ry="5"
        stroke="url(#orbit-gradient)"
        strokeWidth="1.75"
        transform="rotate(-24 16 16)"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="11"
        ry="5"
        stroke="url(#orbit-gradient)"
        strokeWidth="1.75"
        transform="rotate(24 16 16)"
      />
      <circle cx="16" cy="16" r="5.5" fill="url(#orbit-gradient)" />
      <path
        d="M13.4 14.8h5.2c.55 0 1 .45 1 1v2.8c0 .55-.45 1-1 1h-5.2c-.55 0-1-.45-1-1v-2.8c0-.55.45-1 1-1Z"
        fill="white"
        opacity="0.95"
      />
      <path
        d="M13.4 15.5 16 17.2 18.6 15.5"
        stroke="#5b5fe8"
        strokeWidth="0.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
