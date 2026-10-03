// Runs `run` every `intervalMs`, never overlapping: the next run is scheduled when the previous
// one finishes. A failed run is reported and the loop continues; stop() waits for the run in
// progress, so a SIGTERM never interrupts a transaction half-way.
export interface Loop {
  stop: () => Promise<void>
}

export function startLoop(options: {
  intervalMs: number
  onError: (error: unknown) => void
  run: () => Promise<void>
}): Loop {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let current: Promise<void> = Promise.resolve()

  const tick = (): void => {
    current = options
      .run()
      .catch(options.onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, options.intervalMs)
      })
  }

  tick()

  return {
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await current
    },
  }
}
