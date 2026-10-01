/**
 * Whether this process is on its way out. `/healthz` answers 503 while it is set, so the
 * platform stops routing here before the server closes.
 */
let draining = false

export function isDraining(): boolean {
  return draining
}

export function beginDraining(): void {
  draining = true
}
