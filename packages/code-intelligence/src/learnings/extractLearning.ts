import type { LearningCandidate, LearningRuleType } from './types.ts'

export function extractManualLearning(text: string): LearningCandidate | undefined {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (!trimmed) return undefined

  const doNotUse =
    /(?:do not|don't|dont|never)\s+use\s+(.+?)\s*[,;]\s*(?:use|prefer)\s+(.+)$/i.exec(trimmed) ??
    /(?:do not|don't|dont|never)\s+use\s+(.+?)(?:\s+here)?\.\s*(?:we\s+use|use|prefer)\s+(.+)$/i.exec(trimmed) ??
    /(?:do not|don't|dont|never)\s+use\s+(.+)$/i.exec(trimmed)
  if (doNotUse) {
    const avoid = cleanupTerm(doNotUse[1] ?? '')
    const prefer = cleanupTerm(doNotUse[2] ?? '')
    return candidate({
      title: prefer ? `Use ${prefer} instead of ${avoid}` : `Avoid ${avoid}`,
      summary: prefer ? `Avoid ${avoid}; prefer ${prefer}.` : `Avoid ${avoid}.`,
      ruleType: 'avoid_pattern',
      appliesWhen: `When working in this repo, avoid ${avoid}${prefer ? ` and use ${prefer} instead` : ''}.`,
      avoid,
      prefer: prefer || undefined,
      confidence: 1,
      priority: 80,
    })
  }

  const useInsteadOf = /(?:(?:let['’]?s\s+(?:ensure|make\s+sure)\s+(?:we\s+)?)|(?:we\s+should\s+)|(?:ensure\s+(?:we\s+)?))?use\s+(.+?)\s+instead\s+of\s+(?:using\s+)?(.+)$/i.exec(trimmed)
  if (useInsteadOf) {
    const prefer = cleanupTerm(useInsteadOf[1] ?? '')
    const avoid = cleanupTerm(useInsteadOf[2] ?? '')
    return candidate({
      title: `Prefer ${prefer} over ${avoid}`,
      summary: `Prefer ${prefer} over ${avoid}.`,
      ruleType: 'prefer_pattern',
      appliesWhen: `When choosing between ${prefer} and ${avoid} in this repo.`,
      avoid,
      prefer,
      confidence: /\b(let['’]?s|should|make sure|ensure)\b/i.test(trimmed) ? 0.75 : 1,
      priority: 70,
      status: /\b(let['’]?s|should|make sure|ensure)\b/i.test(trimmed) ? 'draft' : 'active',
    })
  }

  const preferOver = /(?:prefer|favor)\s+([^.;,]+?)\s+(?:over|to|instead\s+of)\s+([^.;]+)$/i.exec(trimmed)
  if (preferOver) {
    const prefer = cleanupTerm(preferOver[1] ?? '')
    const avoid = cleanupTerm(preferOver[2] ?? '')
    return candidate({
      title: `Prefer ${prefer} over ${avoid}`,
      summary: `Prefer ${prefer} over ${avoid}.`,
      ruleType: 'prefer_pattern',
      appliesWhen: `When choosing between ${prefer} and ${avoid} in this repo.`,
      avoid,
      prefer,
      confidence: 1,
      priority: 75,
    })
  }

  const neverEdit = /(?:never|do not|don't|dont)\s+edit\s+(.+)$/i.exec(trimmed)
  if (neverEdit) {
    const path = cleanupTerm(neverEdit[1] ?? '')
    return candidate({
      title: `Do not edit ${path}`,
      summary: `Do not edit ${path}.`,
      ruleType: 'generated_code',
      appliesWhen: `When changes would touch ${path}.`,
      avoid: `editing ${path}`,
      pathGlobs: inferPathGlobs(path),
      confidence: 1,
      priority: 90,
    })
  }

  const testsForChanges = /(?:(?:let['’]?s\s+(?:ensure|make\s+sure)\s+(?:we(?:'re|\s+are)?\s+)?)|(?:we\s+should\s+)|(?:always\s+)|(?:ensure\s+(?:we\s+)?))?(?:write|writing|add|adding|include|including)\s+tests\s+for\s+(?:anything|everything|all\s+things|features|code|changes?)\s+(?:we\s+)?(?:add|change|write|implement|make)$/i.exec(trimmed)
  if (testsForChanges) {
    const soft = /\b(let['’]?s|should|make sure|ensure)\b/i.test(trimmed) && !/\balways\b/i.test(trimmed)
    return candidate({
      title: 'Add tests for new changes',
      summary: 'Write tests for anything added or changed when behavior is introduced or modified.',
      ruleType: 'testing_convention',
      appliesWhen: 'When adding or changing behavior in this repo.',
      prefer: 'tests for new or changed behavior',
      confidence: soft ? 0.75 : 1,
      priority: 75,
      status: soft ? 'draft' : 'active',
    })
  }

  const testsUnder = /always\s+add\s+tests\s+under\s+([^.;]+)$/i.exec(trimmed)
  if (testsUnder) {
    const path = cleanupTerm(testsUnder[1] ?? '')
    return candidate({
      title: `Add tests under ${path}`,
      summary: `Always add tests under ${path} when relevant changes are made.`,
      ruleType: 'testing_convention',
      appliesWhen: 'When implementing or changing behavior that needs test coverage.',
      prefer: `tests under ${path}`,
      pathGlobs: inferPathGlobs(path),
      confidence: 1,
      priority: 70,
    })
  }

  return candidate({
    title: titleFromText(trimmed),
    summary: trimmed,
    ruleType: inferRuleType(trimmed),
    appliesWhen: 'When working in this repo and this guidance is relevant.',
    confidence: 1,
    priority: 50,
  })
}

function candidate(input: Omit<LearningCandidate, 'status' | 'source'> & Partial<Pick<LearningCandidate, 'status' | 'source'>>): LearningCandidate {
  return {
    status: input.status ?? 'active',
    source: { kind: 'manual_note', timestamp: new Date().toISOString(), ...(input.source ?? {}) },
    ...input,
  }
}

function cleanupTerm(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/g, '').replace(/\s+here$/i, '')
}

function inferPathGlobs(value: string): string[] | undefined {
  const cleaned = cleanupTerm(value)
  if (!/[/*.]|\w+\/\w+/.test(cleaned)) return undefined
  return [cleaned.includes('*') ? cleaned : cleaned.endsWith('/') ? `${cleaned}**` : cleaned]
}

function inferRuleType(text: string): LearningRuleType {
  if (/test/i.test(text)) return 'testing_convention'
  if (/dependenc|import|package/i.test(text)) return 'dependency_policy'
  if (/generated|do not edit|don't edit/i.test(text)) return 'generated_code'
  if (/style|format|naming/i.test(text)) return 'style'
  if (/auth|domain|business/i.test(text)) return 'domain_rule'
  if (/workflow|process|review/i.test(text)) return 'workflow'
  return 'prefer_pattern'
}

function titleFromText(text: string): string {
  const words = text.replace(/[.。]$/, '').split(/\s+/).slice(0, 10).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
