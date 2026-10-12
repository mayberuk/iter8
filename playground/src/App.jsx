import { AppSidebar, Brand, SiteNav, ThemeToggle } from "./components/Nav.jsx"
import { ToastProvider } from "./components/Toast.jsx"
import { Link, usePath } from "./router.jsx"
import Customers from "./pages/Customers.jsx"
import Dashboard from "./pages/Dashboard.jsx"
import Heavy from "./pages/Heavy.jsx"
import Home from "./pages/Home.jsx"
import Pricing from "./pages/Pricing.jsx"
import Settings from "./pages/Settings.jsx"

const APP_PAGES = {
  "/app": { title: "Dashboard", Page: Dashboard },
  "/app/customers": { title: "Customers", Page: Customers },
  "/app/settings": { title: "Settings", Page: Settings },
}

const SITE_PAGES = { "/": Home, "/pricing": Pricing, "/heavy": Heavy }

const FOOTER_COLUMNS = [
  { heading: "Product", links: [["Overview", "/"], ["Pricing", "/pricing"], ["Dashboard", "/app"]] },
  { heading: "Company", links: [["About", "/"], ["Careers", "/"], ["Contact", "/"]] },
  { heading: "Resources", links: [["Docs", "/"], ["Changelog", "/"], ["Heavy mode", "/heavy"]] },
]

function NotFound() {
  return (
    <section className="mx-auto max-w-xl px-6 py-32 text-center">
      <p className="text-sm font-semibold text-red-600">404</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">Nothing lives here</h1>
      <p className="mt-3 text-slate-600 dark:text-slate-400">The page you asked for does not exist.</p>
      <Link to="/" className="mt-8 inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">
        Back to the homepage
      </Link>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 md:grid-cols-4">
        <div>
          <Brand />
          <p className="mt-3 max-w-xs text-sm text-slate-500 dark:text-slate-400">
            Release notes that write themselves, reviewed by you before every deploy.
          </p>
        </div>
        {FOOTER_COLUMNS.map((column) => (
          <div key={column.heading}>
            <h2 className="text-sm font-semibold">{column.heading}</h2>
            <ul className="mt-3 space-y-2 text-sm text-slate-500 dark:text-slate-400">
              {column.links.map(([label, to]) => (
                <li key={label}>
                  <Link to={to} className="hover:text-slate-900 dark:hover:text-white">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="border-t border-slate-200 py-5 text-center text-xs text-slate-400 dark:border-slate-800">
        © 2026 Lumen Labs. A fictional product for testing.
      </p>
    </footer>
  )
}

function AppShell({ title, children }) {
  return (
    <div className="flex h-screen">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 px-8 dark:border-slate-800">
          <h1 className="text-lg font-semibold">{title}</h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span
              role="img"
              aria-label="Signed in as Maya Okafor"
              className="grid size-8 place-items-center rounded-full bg-red-600 text-xs font-semibold text-white"
            >
              MO
            </span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 p-8 dark:bg-slate-950">{children}</main>
      </div>
    </div>
  )
}

export default function App() {
  const path = usePath()
  const appPage = APP_PAGES[path]
  const SitePage = SITE_PAGES[path]

  return (
    <ToastProvider>
      {appPage ? (
        <AppShell title={appPage.title}>
          <appPage.Page />
        </AppShell>
      ) : (
        <>
          <SiteNav />
          <main>{SitePage ? <SitePage /> : <NotFound />}</main>
          <Footer />
        </>
      )}
    </ToastProvider>
  )
}
