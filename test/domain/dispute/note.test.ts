import { describe, expect, it } from 'vitest'

import { decideNote } from '../../../src/domain/dispute/index.js'
import { analyst, state } from './fixtures.js'

describe('notes', () => {
  it('record work without changing the status or claiming a rule', () => {
    expect(
      decideNote({ actor: analyst, state: state('UNDER_REVIEW'), text: 'called merchant' }),
    ).toMatchObject({
      from: 'UNDER_REVIEW',
      ruleKey: null,
      rulesetVersion: null,
      to: 'UNDER_REVIEW',
      type: 'NOTE_ADDED',
    })
  })

  it('are not written by the system', () => {
    expect(() =>
      decideNote({ actor: { id: 'x', type: 'system' }, state: state('OPEN'), text: 'x' }),
    ).toThrow(/human or an agent/)
  })
})
