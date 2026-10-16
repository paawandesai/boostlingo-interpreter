import { beforeEach, describe, expect, it } from 'vitest'
import { accessHeaders, currentAccessToken, setAccessToken } from './access'

describe('access token', () => {
  beforeEach(() => setAccessToken(''))

  it('drops whitespace pasted around the token', () => {
    setAccessToken('  abc123\n')
    expect(currentAccessToken()).toBe('abc123')
    expect(accessHeaders()).toEqual({ 'X-Access-Token': 'abc123' })
  })

  it('sends no header when the token is only whitespace', () => {
    setAccessToken(' \t')
    expect(accessHeaders()).toEqual({})
  })
})
