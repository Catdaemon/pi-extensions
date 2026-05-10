const CORRECTION_PATTERNS = [
  /\bdon['’]?t\s+use\b/i,
  /\bdo\s+not\s+use\b/i,
  /\bstop\s+using\b/i,
  /\bwe\s+don['’]?t\s+use\b/i,
  /\bwe\s+do\s+not\s+use\b/i,
  /\buse\s+.+\s+instead\b/i,
  /\buse\s+.+\s+instead\s+of\b/i,
  /\bprefer\s+.+\s+(?:over|to|instead\s+of)\b/i,
  /\bfavor\s+.+\s+(?:over|instead\s+of)\b/i,
  /\bavoid\s+.+\s+(?:use|prefer|in\s+favor\s+of)\b/i,
  /\blet['’]?s\s+(?:ensure|make\s+sure)\s+(?:we\s+)?use\b/i,
  /\blet['’]?s\s+(?:ensure|make\s+sure)\s+(?:we(?:'re|\s+are)?\s+)?(?:write|writing|add|adding|include|including)\s+tests\b/i,
  /\bwe\s+should\s+use\b/i,
  /\bwe\s+should\s+(?:write|add|include)\s+tests\b/i,
  /\b(?:please\s+)?(?:always|never)\s+(?:use|prefer|add|run|keep|write|put|place|check|validate|call|name|import|export|mock|edit|modify|include)\b/i,
  /\b(?:make\s+sure|ensure)\s+(?:we\s+)?(?:use|write|add|include|check|validate)\b/i,
  /\bnot\s+the\s+pattern\b/i,
  /\bthat['’]?s\s+wrong\s+here\b/i,
  /\bthis\s+repo\s+uses\b/i,
  /\bshould\s+be\s+integration\b/i,
  /\bshould\s+not\s+be\s+mocked\b/i,
  /\bgenerated\s+file\b/i,
  /\bdon['’]?t\s+edit\b/i,
]

export function maybeCorrectionSignal(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('/') || isConversationalNonGuidance(trimmed)) return false
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(trimmed))
}

function isConversationalNonGuidance(text: string): boolean {
  const lower = text.toLowerCase()
  if (/\b(let's|lets)\s+(?:ensure|make\s+sure)\s+(?:we\s+)?use\b/.test(lower)) return false
  if (/\b(let's|lets)\s+(?:ensure|make\s+sure)\s+(?:we(?:'re|\s+are)?\s+)?(?:write|writing|add|adding|include|including)\s+tests\b/.test(lower)) return false
  if (/\b(let's|lets|can we|could we|why is|what else|is there|seems logical|interestingly|looks good|never mind|for now)\b/.test(lower)) return true
  if (/\b(message to you|my message|your message|you in there|without any context)\b/.test(lower)) return true
  return false
}

export function correctionConfidence(text: string): number {
  const trimmed = text.trim().toLowerCase()
  if (/\b(always|never|this repo|we don't|we do not|do not|don't|prefer .+ (?:over|to|instead of)|favor .+ over|use .+ instead)\b/.test(trimmed)) {
    return /\bhere\b/.test(trimmed) ? 0.82 : 0.9
  }
  if (/\b(let's|lets)\s+ensure\s+.*\btests\b/.test(trimmed)) return 0.75
  if (/\bshould\b|\bnot the pattern\b|\bwrong here\b/.test(trimmed)) return 0.65
  return 0.45
}

export function activationStatusForConfidence(confidence: number): 'active' | 'draft' | 'ignored' {
  if (confidence >= 0.85) return 'active'
  if (confidence >= 0.5) return 'draft'
  return 'ignored'
}
