import { OrbitLogo } from './OrbitLogo'

interface AppBrandProps {
  compact?: boolean
  className?: string
}

export function AppBrand({ compact = false, className }: AppBrandProps) {
  return (
    <div className={`app-brand${className ? ` ${className}` : ''}`}>
      <OrbitLogo size={compact ? 24 : 28} className="app-brand-mark" />
      {!compact && (
        <div className="app-brand-text">
          <span className="app-brand-name">Orbit Mail</span>
          <span className="app-brand-tagline">Your mail, in orbit</span>
        </div>
      )}
    </div>
  )
}
