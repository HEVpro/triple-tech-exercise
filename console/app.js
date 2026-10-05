// The development console: one page over the public API, nothing else. It holds no business
// logic: states, amounts, deadlines and decisions are shown as the API returns them.
// Alpine.js reads this object from the page (x-data="disputeConsole()"); Pico.css styles the
// plain HTML. Why this and not a React application: docs/TRADEOFFS.md §16.

const STATES = [
  { key: 'at_risk', label: 'At risk', meaning: 'Open, deadline inside the risk window' },
  { key: 'breached', label: 'Breached', meaning: 'Lost to the deadline in the last window' },
  { key: 'responded', label: 'Responded', meaning: 'Evidence filed, waiting for the scheme' },
]

function disputeConsole() {
  return {
    asOf: '',
    error: '',
    health: 'checking…',
    history: null,
    items: [],
    loading: false,
    report: null,
    riskWindowDays: 7,
    selected: null,
    STATES,
    states: ['at_risk', 'breached'],
    token: sessionStorage.getItem('token') ?? '',

    // GET with the bearer token; an error envelope becomes the message shown on the page.
    async api(path) {
      const response = await fetch(path, { headers: { authorization: `Bearer ${this.token}` } })
      const body = await response.json()
      if (response.ok) return body
      const hint = response.status === 401 ? ' Mint a new token: npm run -s dev:token' : ''
      throw new Error(`${body.error?.code ?? response.status}: ${body.error?.message ?? ''}${hint}`)
    },

    closeCase() {
      this.history = null
      this.selected = null
      this.asOf = ''
    },

    async connect() {
      sessionStorage.setItem('token', this.token.trim())
      this.token = this.token.trim()
      this.history = null
      await this.loadReport()
    },

    async guarded(work) {
      this.loading = true
      this.error = ''
      try {
        await work()
      } catch (failure) {
        this.error = failure.message
      } finally {
        this.loading = false
      }
    },

    async loadHistory() {
      await this.guarded(async () => {
        // The input has no zone; the API requires one, and every clock here is UTC.
        const query = this.asOf ? `?as_of=${encodeURIComponent(`${this.asOf}:00Z`)}` : ''
        this.history = await this.api(`/cases/${this.selected.id}/history${query}`)
      })
    },

    async loadMore() {
      await this.guarded(async () => {
        const page = await this.api(this.reportPath(this.report.next_cursor))
        this.items.push(...page.items)
        this.report.next_cursor = page.next_cursor
      })
    },

    async loadReport() {
      await this.guarded(async () => {
        this.report = await this.api(this.reportPath(null))
        this.items = this.report.items
      })
    },

    // Minor units to a formatted amount. The exponent comes from the API for the case's own
    // currency, and from the browser's currency data for the base currency.
    money(minor, currency, exponent) {
      const format = new Intl.NumberFormat('en', { currency, style: 'currency' })
      const digits = exponent ?? format.resolvedOptions().maximumFractionDigits
      return format.format(minor / 10 ** digits)
    },

    async openCase(id) {
      this.selected = this.items.find((item) => item.id === id)
      this.asOf = ''
      await this.loadHistory()
      // The history is rendered below the table: bring it into view once it exists.
      this.$nextTick(() => document.getElementById('history')?.scrollIntoView())
    },

    reportPath(cursor) {
      const query = new URLSearchParams({
        risk_window_days: String(this.riskWindowDays),
        state: this.states.join(','),
      })
      if (cursor) query.set('cursor', cursor)
      return `/reports/stuck-queue?${query.toString()}`
    },

    async start() {
      try {
        const ready = await fetch('/readyz')
        this.health = ready.ok ? 'ready, database up' : 'not ready, database unavailable'
      } catch {
        this.health = 'unreachable'
      }
      if (this.token) await this.loadReport()
    },

    timeLeft(seconds) {
      const days = Math.floor(Math.abs(seconds) / 86_400)
      const hours = Math.floor((Math.abs(seconds) % 86_400) / 3_600)
      return seconds >= 0 ? `${days}d ${hours}h` : `${days}d ${hours}h ago`
    },

    totalExposure() {
      return STATES.reduce(
        (sum, state) => sum + this.report.summary[state.key].amount_base_minor,
        0,
      )
    },

    utc(iso) {
      return iso.slice(0, 16).replace('T', ' ')
    },
  }
}

window.disputeConsole = disputeConsole
