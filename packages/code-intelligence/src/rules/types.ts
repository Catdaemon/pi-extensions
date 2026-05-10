export type MachineRuleKind =
  | 'forbidden_import'
  | 'forbidden_call'
  | 'forbidden_path_edit'
  | 'required_test_path'
  | 'forbidden_dependency'
  | 'required_wrapper'

export type MachineRuleSeverity = 'error' | 'warning' | 'info'
export type MachineRuleStatus = 'active' | 'disabled'

export type MachineRule = {
  id: string
  learningId: string
  repoKey: string
  ruleKind: MachineRuleKind
  pattern: string
  message: string
  pathGlobs?: string[]
  languages?: string[]
  severity: MachineRuleSeverity
  status: MachineRuleStatus
  createdAt?: string
  updatedAt?: string
}

export type RetrievedMachineRule = MachineRule & {
  reasons: Array<'hard_rule_match' | 'learning_scope_match'>
}
