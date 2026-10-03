// A caller asked the domain for something it never does, such as the system creating a case.
// This is a programming error in the caller, not a business rejection.
export class DisputeError extends Error {
  override name = 'DisputeError'
}
