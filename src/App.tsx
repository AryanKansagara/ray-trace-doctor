import { lazy, Suspense, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import Landing from './Landing.tsx'

const Tool = lazy(() => import('./Tool.tsx'))

export function go(href: string) {
  history.pushState({}, '', href)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
}

export function Link({ href, className, children, onClick }: { href: string; className?: string; children: ReactNode; onClick?: () => void }) {
  const click = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    onClick?.()
    go(href)
  }
  return (
    <a href={href} className={className} onClick={click}>
      {children}
    </a>
  )
}

function ThemeToggle() {
  const [mode, setMode] = useState(() => document.documentElement.dataset.themeMode ?? 'light')
  const flip = () => {
    const next = mode === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.themeMode = next
    localStorage.setItem('themeMode', next)
    setMode(next)
    dispatchEvent(new CustomEvent('themechange'))
  }
  return (
    <button className="icon-btn" onClick={flip} aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`} title="Toggle theme">
      {mode === 'dark' ? (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  )
}

export function Nav({ inApp, children }: { inApp: boolean; children?: ReactNode }) {
  return (
    <header className="nav">
      <div className={inApp ? 'nav-inner wide' : 'nav-inner'}>
        <Link href="/" className="brand">
          <span className="monogram" aria-hidden>RT</span>
          <span className="brand-name">Ray Trace Doctor</span>
        </Link>
        {!inApp && (
          <nav className="nav-links" aria-label="Page sections">
            <a href="#diagnoses">Diagnoses</a>
            <a href="#how">How it works</a>
            <a href="#privacy">Privacy</a>
          </nav>
        )}
        <div className="nav-right">
          {children}
          <ThemeToggle />
          {!inApp && <Link href="/app" className="btn btn-black btn-sm">Open a trace</Link>}
        </div>
      </div>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="rails footer-inner">
        <span>Built by Aryan Kansagara. Independent project, not affiliated with Anyscale.</span>
        <span className="mono-sm">Traces are parsed in your browser and never uploaded.</span>
      </div>
    </footer>
  )
}

export default function App() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const on = () => setPath(location.pathname)
    addEventListener('popstate', on)
    return () => removeEventListener('popstate', on)
  }, [])
  if (path.startsWith('/app')) {
    return (
      <Suspense fallback={<div className="boot">Loading</div>}>
        <Tool />
      </Suspense>
    )
  }
  return <Landing />
}
