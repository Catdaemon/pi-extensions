import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { complete } from '@earendil-works/pi-ai'
import type { LearningCandidate, LearningRuleType } from '../learnings/types.ts'

const RULE_TYPES: LearningRuleType[] = [
  'avoid_pattern',
  'prefer_pattern',
  'testing_convention',
  'architecture',
  'dependency_policy',
  'generated_code',
  'style',
  'domain_rule',
  'workflow',
]

export async function rewriteLearningCandidateWithModel(
  ctx: ExtensionContext,
  text: string,
  fallback?: LearningCandidate
): Promise<LearningCandidate | undefined> {
  if (!ctx.model) return undefined
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
  if (!auth.ok || !auth.apiKey) return undefined

  const prompt = buildLearningRewritePrompt(text, fallback)
  const response = await complete(
    ctx.model,
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers }
  )
  const raw = response.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return parseLearningRewrite(raw)
}

function buildLearningRewritePrompt(text: string, fallback?: LearningCandidate): string {
  return [
    'Rewrite the user message into one durable codebase learning rule, or return null if it is not durable repo guidance.',
    'Preserve nuance: do not turn a preference into a never/always rule. Softer wording such as "let\'s ensure" or "we should" should usually be draft with confidence around 0.6-0.8.',
    'Prefer precise avoid/prefer fields when the message compares two approaches.',
    'Infer pathGlobs/languages only when obvious from the wording.',
    'Return strict JSON only. No markdown.',
    'Allowed ruleType values: ' + RULE_TYPES.join(', '),
    'Shape:',
    '{"title":"...","summary":"...","ruleType":"prefer_pattern","appliesWhen":"...","avoid":"... optional","prefer":"... optional","pathGlobs":["optional"],"languages":["optional"],"confidence":0.75,"priority":50,"status":"draft|active"}',
    'or null.',
    fallback ? `Fallback regex extraction for reference: ${JSON.stringify(fallback)}` : '',
    `User message: ${text}`,
  ].filter(Boolean).join('\n')
}

export function parseLearningRewrite(raw: string): LearningCandidate | undefined {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (!trimmed || trimmed === 'null') return undefined
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<LearningCandidate>
  if (!parsed || typeof parsed.title !== 'string' || typeof parsed.summary !== 'string' || typeof parsed.appliesWhen !== 'string') return undefined
  const ruleType = RULE_TYPES.includes(parsed.ruleType as LearningRuleType) ? parsed.ruleType as LearningRuleType : 'prefer_pattern'
  const confidence = clampNumber(parsed.confidence, 0.5, 1, 0.65)
  return {
    title: parsed.title.trim(),
    summary: parsed.summary.trim(),
    ruleType,
    appliesWhen: parsed.appliesWhen.trim(),
    avoid: typeof parsed.avoid === 'string' && parsed.avoid.trim() ? parsed.avoid.trim() : undefined,
    prefer: typeof parsed.prefer === 'string' && parsed.prefer.trim() ? parsed.prefer.trim() : undefined,
    pathGlobs: Array.isArray(parsed.pathGlobs) ? parsed.pathGlobs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 8) : undefined,
    languages: Array.isArray(parsed.languages) ? parsed.languages.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 8) : undefined,
    examples: parsed.examples,
    confidence,
    priority: Math.round(clampNumber(parsed.priority, 1, 100, 50)),
    status: parsed.status === 'active' && confidence >= 0.85 ? 'active' : 'draft',
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}
