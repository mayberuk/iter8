import { useId, useState } from "react"
import { Dialog } from "../components/Dialog.jsx"
import { Tabs } from "../components/Tabs.jsx"
import { useToast } from "../components/Toast.jsx"

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WORKSPACE = "lumen-labs"

function validate(values) {
  const errors = {}
  if (!values.name.trim()) errors.name = "Enter your full name."
  if (!values.email.trim()) errors.email = "Enter your work email."
  else if (!EMAIL.test(values.email)) errors.email = "Enter an email like you@company.com."
  if (!values.company.trim()) errors.company = "Enter your company name."
  return errors
}

function Field({ label, name, values, errors, onChange, onBlur, type = "text" }) {
  const id = useId()
  const error = errors[name]
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={values[name]}
        onChange={onChange}
        onBlur={onBlur}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm shadow-sm outline-none focus:ring-2 dark:bg-slate-900 ${
          error
            ? "border-red-500 focus:ring-red-500/40"
            : "border-slate-300 focus:border-red-500 focus:ring-red-500/30 dark:border-slate-700"
        }`}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

function ProfileForm() {
  const toast = useToast()
  const [values, setValues] = useState({ name: "Maya Okafor", email: "maya@lumen.example", company: "Lumen Labs" })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const all = validate(values)
  const errors = Object.fromEntries(Object.entries(all).filter(([name]) => submitted || touched[name]))

  const onChange = (event) => setValues({ ...values, [event.target.name]: event.target.value })
  const onBlur = (event) => setTouched({ ...touched, [event.target.name]: true })
  const onSubmit = (event) => {
    event.preventDefault()
    setSubmitted(true)
    if (Object.keys(all).length === 0) toast("Settings saved")
  }

  const shared = { values, errors, onChange, onBlur }
  return (
    <form noValidate onSubmit={onSubmit} className="max-w-lg space-y-5">
      <Field label="Full name" name="name" {...shared} />
      <Field label="Work email" name="email" type="email" {...shared} />
      <Field label="Company" name="company" {...shared} />
      <button type="submit" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">
        Save changes
      </button>
    </form>
  )
}

const NOTIFICATIONS = [
  ["Weekly digest", "A summary of drafts waiting for review."],
  ["Publish confirmations", "An email each time a note goes out."],
  ["Failed syncs", "Tell me when a repository stops syncing."],
]

function Notifications() {
  return (
    <fieldset className="max-w-lg space-y-4">
      <legend className="sr-only">Email notifications</legend>
      {NOTIFICATIONS.map(([label, hint], index) => (
        <label key={label} className="flex items-start gap-3">
          <input type="checkbox" defaultChecked={index !== 2} className="mt-1 size-4 accent-red-600" />
          <span>
            <span className="block text-sm font-medium">{label}</span>
            <span className="block text-sm text-slate-500 dark:text-slate-400">{hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function DeleteWorkspace() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")

  const close = () => {
    setOpen(false)
    setTyped("")
  }

  return (
    <section
      aria-labelledby="danger-heading"
      className="mt-12 max-w-lg rounded-xl border border-red-200 bg-red-50/60 p-6 dark:border-red-900 dark:bg-red-950/30"
    >
      <h2 id="danger-heading" className="font-semibold text-red-800 dark:text-red-300">
        Danger zone
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Deleting a workspace removes its drafts, published notes and connected repositories.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300"
      >
        Delete workspace
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Delete workspace"
        description={`This cannot be undone. Type ${WORKSPACE} to confirm.`}
      >
        <input
          aria-label="Workspace name"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="mt-4 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-500/40 dark:border-slate-700 dark:bg-slate-950"
        />
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={typed !== WORKSPACE}
            onClick={() => {
              close()
              toast("Workspace deletion is switched off in the playground")
            }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete forever
          </button>
        </div>
      </Dialog>
    </section>
  )
}

export default function Settings() {
  return (
    <div className="mx-auto max-w-4xl">
      <Tabs
        label="Settings sections"
        tabs={[
          { id: "profile", label: "Profile", content: <ProfileForm /> },
          { id: "notifications", label: "Notifications", content: <Notifications /> },
        ]}
      />
      <DeleteWorkspace />
    </div>
  )
}
