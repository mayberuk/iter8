import { startService } from "./service"

const service = await startService()
console.log(service.pid)
if (process.argv[2] === "hang") await new Promise(() => {})
process.exit(0)
