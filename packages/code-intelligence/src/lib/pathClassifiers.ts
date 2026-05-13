export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(path)
}

export function isTestRequirementPattern(pattern: string): boolean {
  return /^(test|tests|__tests__)\/|\/__tests__\/|\.(test|spec)\.[jt]sx?(?:$|\*)/.test(pattern)
}
