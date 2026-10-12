import { useEffect, useRef, useState } from "react"
import { Link } from "../router.jsx"

const linkClass =
  "rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 aria-[current=page]:text-red-700 dark:text-slate-300 dark:hover:text-white dark:aria-[current=page]:text-red-300"

export function Brand({ to = "/" }) {
  return (
    <Link to={to} className="flex items-center gap-2 text-lg font-bold tracking-tight">
      <svg viewBox="0 0 24 24" className="size-6 text-red-600" fill="currentColor" aria-hidden="true">
        <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2Z" />
      </svg>
      Lumen
    </Link>
  )
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))

  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("lumen-theme", next ? "dark" : "light")
    setDark(next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label="Dark mode"
      className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {dark ? (
          <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        )}
      </svg>
    </button>
  )
}

const PRODUCT_LINKS = [
  { to: "/", label: "Overview", hint: "What Lumen does" },
  { to: "/pricing", label: "Plans", hint: "Compare tiers and FAQ" },
  { to: "/app", label: "Dashboard", hint: "See the product" },
]

function ProductMenu() {
  const [open, setOpen] = useState(false)
  const root = useRef(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`${linkClass} flex items-center gap-1`}
      >
        Product
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden="true">
          <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Product"
          className="absolute left-0 top-full mt-2 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-800 dark:bg-slate-900"
        >
          {PRODUCT_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">{item.hint}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function SiteNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
        <Brand />
        <nav aria-label="Main" className="flex flex-1 items-center gap-1">
          <ProductMenu />
          <Link to="/pricing" className={linkClass}>
            Pricing
          </Link>
          <Link to="/heavy" className={linkClass}>
            Heavy mode
          </Link>
        </nav>
        <ThemeToggle />
        <Link
          to="/app"
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
        >
          Open app
        </Link>
      </div>
    </header>
  )
}

const SIDEBAR_LINKS = [
  { to: "/app", label: "Dashboard", icon: "M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z" },
  {
    to: "/app/customers",
    label: "Customers",
    icon: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM4 21a8 8 0 0 1 16 0H4Z",
  },
  {
    to: "/app/settings",
    label: "Settings",
    icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8.4-2.3a8 8 0 0 0 0-1.4l2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.2-.7L16.4 4h-4l-.4 2.6c-.4.2-.8.4-1.2.7l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 1.4l-2 1.6 2 3.4 2.4-1c.4.3.8.5 1.2.7l.4 2.6h4l.4-2.6c.4-.2.8-.4 1.2-.7l2.4 1 2-3.4-2-1.6Z",
  },
]

export function AppSidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex h-16 items-center border-b border-slate-200 px-5 dark:border-slate-800">
        <Brand to="/app" />
      </div>
      <nav aria-label="App" className="flex flex-1 flex-col gap-1 p-3">
        {SIDEBAR_LINKS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-white hover:text-slate-900 aria-[current=page]:bg-white aria-[current=page]:text-red-700 aria-[current=page]:shadow-sm dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white dark:aria-[current=page]:bg-slate-800 dark:aria-[current=page]:text-red-300"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
              <path d={item.icon} />
            </svg>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <Link to="/" className="block rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-white dark:text-slate-400 dark:hover:bg-slate-800">
          ← Back to site
        </Link>
      </div>
    </aside>
  )
}
