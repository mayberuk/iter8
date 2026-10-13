import { Link } from "../router.jsx"

const FEATURES = [
  {
    title: "Reads every merge",
    body: "Connect GitHub or GitLab once. Lumen follows every branch you ship from.",
    icon: "M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0a9 9 0 0 1-9 9",
  },
  {
    title: "Writes in your voice",
    body: "Feed it three past announcements and it matches tone, length and formatting.",
    icon: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z",
  },
  {
    title: "Never ships unread",
    body: "Every draft waits for a human. Nothing posts until someone presses publish.",
    icon: "M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Zm-1 12-3-3 1.4-1.4L11 12.2l3.6-3.6L16 10l-5 5Z",
  },
  {
    title: "Groups by impact",
    body: "Fixes, features and breaking changes land in separate sections, ordered by who they affect.",
    icon: "M4 6h16M4 12h10M4 18h6",
  },
  {
    title: "Publishes anywhere",
    body: "Push to your changelog page, Slack channel, email digest or in-app announcement.",
    icon: "M4 12 20 4l-4 16-4-6-8-2Z",
  },
  {
    title: "Tracks what landed",
    body: "See which customers opened each note and which features they tried afterwards.",
    icon: "M4 19V9m6 10V5m6 14v-7m6 7H2",
  },
]

export default function Home() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 -z-10 h-[32rem] bg-gradient-to-b from-red-100 via-white to-transparent dark:from-red-950/50 dark:via-slate-950"
        />
        <div className="mx-auto max-w-4xl px-6 pb-24 pt-24 text-center">
          <p className="mx-auto w-fit rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-700 dark:border-red-900 dark:bg-slate-900 dark:text-red-300">
            New in 2.0
          </p>
          <h1 className="mt-6 bg-gradient-to-r from-red-600 to-orange-500 bg-clip-text text-5xl font-extrabold tracking-tight text-transparent sm:text-6xl">
            Ship faster with release notes that write themselves
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600 dark:text-slate-300">
            Lumen reads your merged pull requests and drafts customer-facing notes in your voice, ready for review
            before every deploy.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link to="/pricing" className="rounded-lg bg-red-600 px-6 py-3 font-semibold text-white shadow-lg shadow-red-600/20 hover:bg-red-700">
              Start free trial
            </Link>
            <Link to="/app" className="rounded-lg border border-slate-300 px-6 py-3 font-semibold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
              Watch the demo
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="features-heading" className="mx-auto max-w-6xl px-6 py-20">
        <h2 id="features-heading" className="text-center text-3xl font-bold tracking-tight">
          Everything between merge and announcement
        </h2>
        <ul className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li
              key={feature.title}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
            >
              <span className="grid size-10 place-items-center rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={feature.icon} />
                </svg>
              </span>
              <h3 className="mt-4 text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{feature.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="rating-heading" className="border-y border-slate-200 bg-slate-50 py-16 dark:border-slate-800 dark:bg-slate-900/40">
        <div className="mx-auto max-w-xl px-6 text-center">
          <h2 id="rating-heading" className="text-2xl font-bold tracking-tight">
            How was your first draft?
          </h2>
          <p className="mt-2 text-slate-600 dark:text-slate-400">Rate the notes Lumen wrote for the demo repository.</p>
          <div className="mt-6">
            <pg-rating value="4" label="Rate the demo draft" />
          </div>
        </div>
      </section>
    </>
  )
}
