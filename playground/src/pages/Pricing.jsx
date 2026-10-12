import { useState } from "react"
import { Accordion } from "../components/Accordion.jsx"
import { Link } from "../router.jsx"

const TIERS = [
  {
    name: "Starter",
    monthly: 0,
    blurb: "For side projects and small teams getting started.",
    features: ["3 repositories", "20 drafts a month", "Markdown export", "Community support"],
  },
  {
    name: "Team",
    monthly: 29,
    featured: true,
    blurb: "For product teams shipping every week.",
    features: ["Unlimited repositories", "Unlimited drafts", "Voice matching", "Slack and email publishing", "Email support"],
  },
  {
    name: "Scale",
    monthly: 99,
    blurb: "For companies with compliance and approval needs.",
    features: ["Everything in Team", "Approval workflows", "SSO and audit log", "Custom changelog domain", "Priority support"],
  },
]

const FAQ = [
  {
    question: "Does Lumen publish anything without my approval?",
    answer: "Never. Every draft waits in a review queue until someone on your team presses publish.",
  },
  {
    question: "Which source hosts do you support?",
    answer: "GitHub, GitLab and Bitbucket, including self-hosted GitLab behind a firewall through our relay.",
  },
  {
    question: "Can I change plans later?",
    answer: "Yes. Upgrades apply immediately and downgrades take effect at the end of the billing period.",
  },
  {
    question: "Is there a discount for open source?",
    answer: "Public repositories on the Team plan are free. Write to us with the repository link.",
  },
]

export default function Pricing() {
  const [annual, setAnnual] = useState(false)

  return (
    <div className="mx-auto max-w-6xl px-6 py-20">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Simple pricing</h1>
        <p className="mt-3 text-lg text-slate-600 dark:text-slate-300">
          Every plan includes unlimited collaborators and a 14-day trial.
        </p>
        <label className="mt-8 inline-flex cursor-pointer items-center gap-3 text-sm font-medium">
          <input type="checkbox" checked={annual} onChange={(event) => setAnnual(event.target.checked)} className="size-4 accent-red-600" />
          Bill annually and save 20%
        </label>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-3">
        {TIERS.map((tier) => {
          const price = Math.round(tier.monthly * (annual ? 0.8 : 1))
          return (
            <section
              key={tier.name}
              aria-labelledby={`tier-${tier.name}`}
              className={`flex flex-col rounded-2xl border p-8 ${
                tier.featured
                  ? "border-red-600 bg-white shadow-xl ring-1 ring-red-600 dark:bg-slate-900"
                  : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              }`}
            >
              <h2 id={`tier-${tier.name}`} className="text-lg font-semibold">
                {tier.name}
                {tier.featured && (
                  <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">
                    Popular
                  </span>
                )}
              </h2>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{tier.blurb}</p>
              <p className="mt-6 text-4xl font-bold">
                ${price}
                <span className="text-base font-normal text-slate-500">/month</span>
              </p>
              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span className="text-red-600" aria-hidden="true">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                to="/app"
                className={`mt-8 rounded-lg px-4 py-2.5 text-center text-sm font-semibold ${
                  tier.featured
                    ? "bg-red-600 text-white hover:bg-red-700"
                    : "border border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                }`}
              >
                Choose {tier.name}
              </Link>
            </section>
          )
        })}
      </div>

      <section aria-labelledby="faq-heading" className="mx-auto mt-24 max-w-3xl">
        <h2 id="faq-heading" className="mb-6 text-2xl font-bold tracking-tight">
          Frequently asked questions
        </h2>
        <Accordion items={FAQ} />
      </section>
    </div>
  )
}
